# signalk-espos-stream

Streams a browser-rendered Signal K dashboard (Freeboard-SK, KIP, any URL) to
an [espOS](https://github.com/dirkwa/espOS) panel — an ESP32-P4 cockpit
display — as ACK-paced MJPEG, with a touch backchannel so the panel can drive
the page. The whole capture chain runs in a single managed container; the
plugin's only host-side job is configuration, lifecycle and health.

Successor to `signalk-esp32-stream`, replacing its host-installed
Xvfb/Chromium/ffmpeg chain and systemd unit with a container managed through
[signalk-container](https://github.com/dirkwa/signalk-container).

## How it works

```text
┌────────────────────────────── sk-espos-stream container ─────────────┐
│ Xvfb :99 ── Chromium kiosk (capture URL) ── ffmpeg x11grab (MJPEG)   │
│      ▲                                             │                 │
│   XTEST                                     latest-frame slot        │
│      │                                             │                 │
│ UDP :5005 touch ◄──────────┐            TCP :5004 ACK-paced stream   │
│ http://127.0.0.1:5006/health (plugin-only)         │                 │
└────────────────────────────┼───────────────────────┼─────────────────┘
                             │                       ▼
                        espOS panel  ◄──── [u32 BE len][JPEG], 1-byte ACK
```

- **Stream (TCP)**: `[u32 BE length][baseline JPEG]`; the panel sends a
  1-byte ACK after each frame reaches its renderer, and the server responds
  with only the _newest_ frame — at most one frame in flight, so the panel
  paces its own frame rate and the ESP32's WiFi link is never flooded.
- **Touch (UDP)**: 8-byte packets; the first 5 bytes are significant —
  little-endian `u16 x, u16 y, u8 type` (0 down / 1 move / 2 up) — and
  bytes 5–7 are reserved padding the server ignores. Injected into the
  kiosk via XTEST; only packets from the connected stream client's IP are
  accepted.
- **Host networking**: the container shares the host network namespace, so
  the default capture URL `http://localhost:80/...` reaches Signal K
  directly and the stream/touch ports bind on the host as-is.

The matching panel-side widget is the `stream` widget in
[espos-p4-cockpit](https://github.com/dirkwa/espos-p4-cockpit); layouts are
designed with signalk-hmi-designer.

## Requirements

- Signal K server ≥ 2.x, Node ≥ 22
- [signalk-container](https://github.com/dirkwa/signalk-container) installed
  and enabled (this plugin declares it via `signalk.requires`)
- podman or docker reachable by signalk-container
- linux/arm64 or an image you built locally (see below)

## Configuration

| Setting                | Default                                      | Notes                                               |
| ---------------------- | -------------------------------------------- | --------------------------------------------------- |
| Capture URL            | `http://localhost:80/@signalk/freeboard-sk/` | page the kiosk renders                              |
| Image tag              | `auto`                                       | image released in lockstep with this plugin version |
| Width x Height         | `1024x600`                                   | match the panel display                             |
| Frame rate             | `15`                                         | ceiling; the panel self-paces below it              |
| JPEG quality           | `6`                                          | ffmpeg `-q:v`, lower is better                      |
| Stream port            | `5004` (TCP)                                 | panel `stream` widget `port`                        |
| Touch port             | `5005` (UDP)                                 | panel `stream` widget `touch_port`                  |
| Touch injection        | on                                           |                                                     |
| Advanced: health port  | `5006`                                       | loopback-only                                       |
| Advanced: memory limit | `1g`                                         | Chromium peaks ~500 MB at 1024x600                  |

### Kiosk login (no keyboard)

On a server with security enabled, Freeboard-SK pops a login dialog that a
touch-only panel can never answer. Set the **Access token** option instead:
the plugin appends it to the capture URL as `?token=…`, which Freeboard-SK
reads at launch and uses for both REST and its stream connection — the
login dialog never appears (this is FSK's supported kiosk path; the Login
menu item is hidden when a URL token is present).

Click **Generate (1 year)** next to the Access token field in the plugin's
config panel: it mints a token for your logged-in user through the
server's own security strategy (the same signing path as
`signalk-generate-token`) and fills the field — then Save. The admin-only
`POST /plugins/signalk-espos-stream/api/kiosk-token` route behind the
button also accepts `{"user": "...", "expiration": "90d"}` if you prefer a
dedicated read-mostly kiosk user or a shorter life.

Alternatively, mint one by hand with the server's bundled tool:

```bash
signalk-generate-token -u <user> -e 1y -s ~/.signalk/security.json
```

The token inherits the named user's permissions, and it appears in the
container's command line locally (`podman inspect`), so treat host access
as equivalent to holding the token. Device access tokens can't be reused
here: the server stores only device metadata, never the token itself —
that lives on the device.

The Chromium profile persists in the plugin's data directory
(`.../plugin-config-data/signalk-espos-stream/chromium-profile`), so a
login performed in the kiosk (e.g. Freeboard credentials) survives container
recreation.

## Local image build (development)

The released image lives at `ghcr.io/dirkwa/signalk-espos-stream` and is
published by CI on release tags. For development on the server itself:

```bash
npm run build-image   # tags ghcr.io/dirkwa/signalk-espos-stream:dev and :<version>
```

Set the plugin's Image tag to `dev` (or leave `auto`, which matches the
version tag the script also applies).

## Security notes

- The stream and touch ports have no authentication; the touch injector is
  gated to the connected stream client's source IP, and the stream serves
  one client at a time. Only expose these ports on trusted (boat) networks.
- Chromium runs `--no-sandbox` inside the container (required for kiosk use
  in a container); the container itself is the sandbox boundary.

## License

Source-available, no redistribution — see [LICENSE.md](LICENSE.md).
