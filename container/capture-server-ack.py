#!/usr/bin/env python3
"""
ACK-paced capture server — protocol v2 for the espOS cockpit "stream" widget.

Supervises the whole capture chain in one process:
  Xvfb :99  ->  Chromium kiosk (Freeboard/KIP/any URL)  ->  ffmpeg x11grab
  -> latest-frame slot -> TCP :5004 ([u32 BE len][JPEG], wait 1-byte ACK)
and injects UDP :5005 touch packets into the X display via XTEST.

The ACK gate sends only the NEWEST frame after each client ACK, so at most
one frame is in flight (esp-hosted-mcu#184 mitigation) and the panel paces
its own fps. Touch packets: LE u16 x, u16 y, u8 type (0 down/1 move/2 up).

Container edition: geometry/profile are arguments, an in-process wait for
the capture URL replaces the old systemd ExecStartPre, and a loopback HTTP
health endpoint reports chain state and throughput for the managing plugin.

Usage:
  python3 capture-server-ack.py \
      [--url http://localhost:80/@signalk/freeboard-sk/] \
      [--port 5004] [--touch-port 5005] [--fps 15] [--quality 6] \
      [--width 1024] [--height 600] [--display :99] [--profile /profile] \
      [--health-port 5006] [--wait-url] [--touch on|off] [--disable-dev-shm]
"""

import argparse
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ACK_TIMEOUT_S = 30.0
JPEG_SOI = b"\xff\xd8"
JPEG_EOI = b"\xff\xd9"


class LatestFrame:
    """1-deep slot. close() marks the producer dead so consumers unblock."""

    def __init__(self):
        self._cond = threading.Condition()
        self._jpeg = None
        self._seq = 0
        self.closed = False

    def publish(self, jpeg: bytes):
        with self._cond:
            self._jpeg = jpeg
            self._seq += 1
            self._cond.notify_all()

    def close(self):
        with self._cond:
            self.closed = True
            self._cond.notify_all()

    def take_newer_than(self, seq: int):
        """Newest (jpeg, seq), or (None, seq) once the producer is gone —
        without this a client would block in wait() forever (the socket
        ACK timeout does not cover a Condition wait)."""
        with self._cond:
            while self._seq <= seq and not self.closed:
                self._cond.wait()
            if self._seq <= seq:
                return None, seq
            return self._jpeg, self._seq


class Stats:
    """Shared state behind /health. Throughput numbers come from the ACK
    loop's existing 5 s reporting window, so /health polling adds no work."""

    def __init__(self):
        self._lock = threading.Lock()
        self._client = None
        self._frames_sent = 0
        self._fps = 0.0
        self._kbps = 0.0
        self._started = time.monotonic()
        self.slot = None  # set in main; chainAlive = not slot.closed

    def client_connected(self, ip: str):
        with self._lock:
            self._client = ip
            self._fps = 0.0
            self._kbps = 0.0

    def client_gone(self):
        with self._lock:
            self._client = None
            self._fps = 0.0
            self._kbps = 0.0

    def report(self, frames_total: int, fps: float, kbps: float):
        with self._lock:
            self._frames_sent = frames_total
            self._fps = fps
            self._kbps = kbps

    def snapshot(self) -> dict:
        with self._lock:
            return {
                # Still-starting (slot unset) counts as alive: the readiness
                # gate polls /health before the chain is up, and only a
                # closed slot proves death.
                "chainAlive": self.slot is None or not self.slot.closed,
                "client": self._client,
                "framesSent": self._frames_sent,
                "fps": self._fps,
                "kbps": self._kbps,
                "uptimeS": time.monotonic() - self._started,
            }


stats = Stats()

# Set by main() when --auth-token is given: the kiosk Chromium starts on
# /bootstrap, which plants the Signal K auth cookie for host "localhost"
# (cookies are port-agnostic) before redirecting to the capture URL. The
# app frameworks attach a URL token to their own API calls, but plain tile
# <img> loads carry only cookies — without this, charts render black on a
# secured server.
bootstrap_token = None
bootstrap_target = None


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/bootstrap" and bootstrap_token and bootstrap_target:
            body = (
                "<!doctype html><script>\n"
                "document.cookie = 'JAUTHENTICATION=' + %s +\n"
                "  '; path=/; max-age=31536000; SameSite=Strict';\n"
                "location.replace(%s);\n"
                "</script>" % (json.dumps(bootstrap_token),
                               json.dumps(bootstrap_target))
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(stats.snapshot()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass  # health polls every few seconds — keep the journal quiet


def start_health_server(port: int):
    server = ThreadingHTTPServer(("127.0.0.1", port), HealthHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"health endpoint on http://127.0.0.1:{port}/health", flush=True)


def wait_for_url(url: str, budget_s: float = 120.0):
    """Block until the capture URL answers (any HTTP status counts — the
    server being up is what matters). Chromium loads the URL exactly once;
    without this a kiosk started before Signal K sits on an error page
    forever. Proceeds after the budget so a broken URL still gets a visible
    error page rather than a supervisor crash loop."""
    deadline = time.monotonic() + budget_s
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2).close()
            print(f"capture URL is up: {url}", flush=True)
            return
        except urllib.error.HTTPError:
            print(f"capture URL answered (HTTP error, server is up): {url}",
                  flush=True)
            return
        except OSError:
            time.sleep(2)
    print(f"capture URL still down after {budget_s:.0f}s, proceeding: {url}",
          flush=True)


def start_xvfb(display: str, width: int, height: int):
    # A container RESTART (as opposed to a recreate) keeps /tmp, so a
    # previous run's lock/socket survive and Xvfb refuses the display.
    # Nothing else owns X displays inside this container — clear them.
    num = display.lstrip(":")
    for stale in (f"/tmp/.X{num}-lock", f"/tmp/.X11-unix/X{num}"):
        try:
            os.unlink(stale)
            print(f"removed stale {stale}", flush=True)
        except FileNotFoundError:
            pass
    p = subprocess.Popen(
        ["Xvfb", display, "-screen", "0", f"{width}x{height}x24",
         "-nolisten", "tcp"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    lock = f"/tmp/.X{display.lstrip(':')}-lock"
    for _ in range(50):
        if os.path.exists(lock):
            return p
        time.sleep(0.1)
    return p  # keep going; chromium will fail loudly if X never came up


def start_chromium(display: str, url: str, width: int, height: int,
                   profile: str, disable_dev_shm: bool):
    binary = shutil.which("chromium") or shutil.which("chromium-browser")
    if not binary:
        sys.exit("no chromium binary found")
    env = {**os.environ, "DISPLAY": display}
    args = [binary, "--kiosk", "--no-sandbox", "--disable-gpu",
            f"--window-size={width},{height}", "--window-position=0,0",
            "--no-first-run", "--disable-infobars", "--hide-scrollbars",
            "--noerrdialogs", "--disable-session-crashed-bubble",
            f"--user-data-dir={profile}"]
    if disable_dev_shm:
        args.append("--disable-dev-shm-usage")
    args.append(url)
    return subprocess.Popen(
        args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def start_ffmpeg(display: str, fps: int, quality: int, width: int, height: int):
    cmd = [
        "ffmpeg",
        "-loglevel", "error",  # quiet, but capture-chain failures stay visible
        "-probesize", "32",
        "-fflags", "nobuffer",
        "-f", "x11grab",
        "-framerate", str(fps),
        "-s", f"{width}x{height}",
        "-draw_mouse", "0",
        "-i", display,
        "-pix_fmt", "yuvj420p",  # 4:2:0 baseline — what the P4 HW decoder wants
        "-vcodec", "mjpeg",
        "-q:v", str(quality),
        "-huffman", "default",
        "-f", "image2pipe",
        "-an",
        "-flush_packets", "1",
        "pipe:1",
    ]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE)  # stderr inherited


def frame_reader(ffmpeg, slot: LatestFrame):
    """Drain ffmpeg stdout continuously; keep only the newest complete JPEG."""
    fd = ffmpeg.stdout.fileno()
    buf = b""
    while True:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        while True:
            soi = buf.find(JPEG_SOI)
            if soi < 0:
                # A chunk may end mid-marker: keep a trailing 0xFF, it can be
                # the first byte of the next SOI.
                buf = buf[-1:] if buf.endswith(b"\xff") else b""
                break
            if soi > 0:
                buf = buf[soi:]
            eoi = buf.find(JPEG_EOI, 2)
            if eoi < 0:
                break
            slot.publish(buf[:eoi + 2])
            buf = buf[eoi + 2:]
    print("capture chain ended (ffmpeg stdout closed)", flush=True)
    slot.close()  # unblock any client waiting on the next frame


# IP of the currently-connected stream client; touch packets from anyone
# else are dropped. XTEST drives the kiosk UI, so an open UDP port would
# hand control of the plotter to any host on the network — tying it to the
# active stream connection needs no configuration and no shared secret.
allowed_touch_ip = None
allowed_touch_lock = threading.Lock()


def touch_injector(display_str: str, port: int):
    from Xlib import X, display as xdisplay
    from Xlib.ext import xtest
    os.environ["DISPLAY"] = display_str
    d = xdisplay.Display(display_str)
    root = d.screen().root

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("0.0.0.0", port))
    print(f"touch injector on UDP {port} -> {display_str} "
          f"(stream client only)", flush=True)
    while True:
        data, src = s.recvfrom(64)
        with allowed_touch_lock:
            allowed = allowed_touch_ip
        if allowed is None or src[0] != allowed:
            continue
        if len(data) < 5:
            continue
        x, y = struct.unpack("<HH", data[:4])
        t = data[4]
        if t == 0:
            xtest.fake_input(d, X.MotionNotify, x=x, y=y, root=root)
            xtest.fake_input(d, X.ButtonPress, detail=1, root=root)
        elif t == 1:
            xtest.fake_input(d, X.MotionNotify, x=x, y=y, root=root)
        else:
            xtest.fake_input(d, X.ButtonRelease, detail=1, root=root)
        d.flush()


def handle_client(conn: socket.socket, addr, slot: LatestFrame):
    global allowed_touch_ip
    print(f"client connected: {addr}", flush=True)
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    conn.settimeout(ACK_TIMEOUT_S)
    with allowed_touch_lock:
        allowed_touch_ip = addr[0]
    stats.client_connected(addr[0])
    sent = 0
    sent_bytes = 0
    seq = 0
    t_report = time.monotonic()
    s_report = b_report = 0
    try:
        while True:
            jpeg, seq = slot.take_newer_than(seq)
            if jpeg is None:
                print(f"client {addr}: capture chain gone, dropping", flush=True)
                return
            conn.sendall(struct.pack(">I", len(jpeg)) + jpeg)
            sent += 1
            sent_bytes += len(jpeg) + 4
            if not conn.recv(1):
                print(f"client {addr} closed (EOF)", flush=True)
                return
            now = time.monotonic()
            if now - t_report >= 5.0:
                dt = now - t_report
                fps = (sent - s_report) / dt
                kbps = (sent_bytes - b_report) / dt / 1024
                print(f"  {addr}: {sent} frames, {fps:.1f} fps, "
                      f"{kbps:.0f} KB/s", flush=True)
                stats.report(sent, fps, kbps)
                t_report, s_report, b_report = now, sent, sent_bytes
    except socket.timeout:
        print(f"client {addr}: no ACK in {ACK_TIMEOUT_S}s, dropping after {sent}",
              flush=True)
    except (BrokenPipeError, ConnectionResetError, OSError) as e:
        print(f"client {addr} disconnected after {sent} frames: {e}", flush=True)
    finally:
        with allowed_touch_lock:
            allowed_touch_ip = None
        stats.client_gone()
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:80/@signalk/freeboard-sk/")
    ap.add_argument("--port", type=int, default=5004)
    ap.add_argument("--touch-port", type=int, default=5005)
    ap.add_argument("--fps", type=int, default=15)
    ap.add_argument("--quality", type=int, default=6)
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--height", type=int, default=600)
    ap.add_argument("--display", default=":99")
    ap.add_argument("--profile", default="/profile")
    ap.add_argument("--health-port", type=int, default=5006)
    ap.add_argument("--wait-url", action="store_true",
                    help="wait for --url to answer before starting Chromium")
    ap.add_argument("--touch", choices=["on", "off"], default="on")
    ap.add_argument("--auth-token", default="",
                    help="Signal K access token; planted as the server auth "
                         "cookie via a bootstrap page so tile/image requests "
                         "authenticate too")
    ap.add_argument("--disable-dev-shm", action="store_true",
                    help="Chromium --disable-dev-shm-usage (shm goes to /tmp)")
    args = ap.parse_args()
    if args.fps < 1:
        ap.error("--fps must be >= 1")
    if not 2 <= args.quality <= 31:
        ap.error("--quality must be 2..31 (ffmpeg -q:v, lower is better)")
    if not 64 <= args.width <= 4096 or not 64 <= args.height <= 4096:
        ap.error("--width/--height must be 64..4096")

    # This process is container PID 1: a stop delivers SIGTERM, whose
    # default action skips the finally-teardown below and leaves Xvfb,
    # Chromium and ffmpeg to be SIGKILLed at the runtime's grace timeout.
    # Raise SystemExit instead so the reverse-order teardown always runs.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    children = []
    try:
        # Health first: the managing plugin's readiness gate polls it while
        # the chain below is still coming up.
        start_health_server(args.health_port)
        if args.wait_url:
            wait_for_url(args.url)

        print(f"Xvfb {args.display} {args.width}x{args.height}", flush=True)
        children.append(start_xvfb(args.display, args.width, args.height))
        time.sleep(1)
        start_url = args.url
        if args.auth_token:
            # The bootstrap MUST be served on the same hostname as the
            # capture URL: cookies are host-scoped, so one planted via
            # 127.0.0.1 never reaches a page loaded via localhost. The
            # health server listens on loopback, which both names reach.
            cap_host = urllib.parse.urlsplit(args.url).hostname or ""
            if cap_host in ("localhost", "127.0.0.1"):
                global bootstrap_token, bootstrap_target
                bootstrap_token = args.auth_token
                bootstrap_target = args.url
                start_url = f"http://{cap_host}:{args.health_port}/bootstrap"
                print("auth cookie bootstrap enabled", flush=True)
            else:
                print(f"auth cookie bootstrap skipped: capture host "
                      f"'{cap_host}' is not loopback", flush=True)
        print(f"chromium kiosk -> {args.url}", flush=True)
        children.append(start_chromium(args.display, start_url,
                                       args.width, args.height,
                                       args.profile, args.disable_dev_shm))
        time.sleep(3)  # let first paint happen before grabbing
        print(f"ffmpeg x11grab {args.fps} fps q{args.quality}", flush=True)
        ffmpeg = start_ffmpeg(args.display, args.fps, args.quality,
                              args.width, args.height)
        children.append(ffmpeg)

        slot = LatestFrame()
        stats.slot = slot
        threading.Thread(target=frame_reader, args=(ffmpeg, slot), daemon=True).start()
        if args.touch == "on":
            threading.Thread(target=touch_injector,
                             args=(args.display, args.touch_port),
                             daemon=True).start()
        else:
            print("touch injection disabled", flush=True)

        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("0.0.0.0", args.port))
        server.listen(1)
        print(f"ACK-paced MJPEG on TCP {args.port}", flush=True)
        # Timed accept so a capture-chain death is noticed even while no
        # client is connected — a blocking accept() would defer the exit
        # (and the supervisor restart) until the next connection attempt.
        server.settimeout(1.0)
        while not slot.closed:
            try:
                conn, addr = server.accept()
            except socket.timeout:
                continue
            handle_client(conn, addr, slot)
        # Dead capture chain: exit non-zero so the container restart policy
        # relaunches the whole stack instead of it sitting there looking
        # healthy.
        print("exiting: capture chain is dead", flush=True)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nshutting down", flush=True)
    finally:
        # terminate() alone can leave Xvfb holding /tmp/.X<n>-lock, which
        # makes the next start_xvfb() adopt a display it never owned. In the
        # container that /tmp dies with the mount namespace, but the reverse
        # teardown keeps SIGTERM stops clean.
        for p in reversed(children):
            try:
                p.terminate()
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=3)
            except Exception:
                pass


if __name__ == "__main__":
    main()
