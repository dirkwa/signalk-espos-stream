/**
 * ServiceRunner — capture-container lifecycle + health loop for
 * signalk-espos-stream.
 *
 *   start → resolve profile mount → ManagedContainer.start
 *         → /health readiness gate → health loop (plugin status line)
 *   stop  → container.stop() → 'Stopped'
 *
 * The container runs with host networking, so the helper's `readiness`
 * option (which needs signalkAccessiblePorts + resolveAddress) is
 * deliberately omitted; readiness is waitForHttpReady against the capture
 * server's loopback /health port.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ManagedContainer,
  resolveMount,
  startSafely,
  waitForContainerManager,
  waitForHttpReady,
  errMsg,
  type ContainerState,
} from "signalk-container-helper";
import {
  buildContainerConfig,
  CONTAINER_NAME,
  defaultSettings,
  GITHUB_REPO,
  IMAGE,
  PLUGIN_ID,
  PROFILE_CONTAINER_PATH,
  resolveTag,
  type ProfileMount,
  type StreamSettings,
} from "./config.js";
import { fetchHealth, healthUrl, type HealthPayload } from "./health.js";

/** Structural slice of the Signal K plugin `app` object the runner needs. */
export interface StreamApp {
  debug(msg: string): void;
  error(msg: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  getDataDirPath(): string;
}

export type ServiceStatus = "starting" | "ready" | "stopped" | "error";

export interface RunnerTiming {
  /** Budget for waiting on the signalk-container manager. */
  managerTimeoutMs: number;
  /** /health readiness deadline after container start. */
  readyMaxMs: number;
  /** Readiness poll interval. */
  readyIntervalMs: number;
  /** Health-loop probe interval. */
  healthIntervalMs: number;
  /** Health-loop per-probe timeout. */
  healthTimeoutMs: number;
  /** Consecutive failures before the error transition. */
  healthFailThreshold: number;
}

export const DEFAULT_TIMING: RunnerTiming = {
  managerTimeoutMs: 120_000,
  readyMaxMs: 120_000, // cold chromium profile + first paint can be slow
  readyIntervalMs: 1_000,
  healthIntervalMs: 10_000,
  healthTimeoutMs: 3_000,
  healthFailThreshold: 3,
};

export interface LastHealth {
  ok: boolean;
  /** Date.now() of the probe result. */
  at: number;
  payload: HealthPayload | null;
  error?: string;
}

export interface StatusReport {
  status: ServiceStatus;
  tag: string;
  containerState: ContainerState;
  lastHealth: LastHealth | null;
  streamPort: number;
  touchPort: number;
}

function sleepFree(timer: NodeJS.Timeout): void {
  timer.unref?.();
}

export class ServiceRunner {
  readonly container: ManagedContainer;

  private readonly app: StreamApp;
  private readonly timing: RunnerTiming;
  private settings: StreamSettings = defaultSettings();
  private profile: ProfileMount | null = null;
  private running = false;
  private runToken = 0;
  private status: ServiceStatus = "stopped";
  private healthTimer: NodeJS.Timeout | null = null;
  private probeInFlight = false;
  private consecutiveFailures = 0;
  private lastHealth: LastHealth | null = null;
  private lastStatusLine = "";

  constructor(app: StreamApp, timing: Partial<RunnerTiming> = {}) {
    this.app = app;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.container = new ManagedContainer({
      app,
      pluginId: PLUGIN_ID,
      name: CONTAINER_NAME, // runtime name: sk-espos-stream
      image: IMAGE,
      defaultTag: "auto",
      resolveTag,
      managerTimeoutMs: this.timing.managerTimeoutMs,
      buildConfig: (tag) =>
        buildContainerConfig(this.settings, tag, this.requireProfile()),
      updates: {
        // Image tags are published in lockstep with GitHub releases (v-tags).
        versionSource: { githubReleases: GITHUB_REPO, tagPrefix: "v" },
      },
      ensureOptions: {
        // signalk-container's recurring (60 s) monitor hook.
        healthCheck: () => this.quickProbe(),
        onUnhealthy: (name, error) =>
          this.app.debug(`container ${name} reported unhealthy: ${error}`),
        onContainerLog: (line: string) => this.app.debug(`[capture] ${line}`),
      },
      // NO `readiness`: HTTP-only helper readiness needs
      // signalkAccessiblePorts, which host networking excludes. The
      // waitForHttpReady gate below is our readiness.
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentSettings(): StreamSettings {
    return this.settings;
  }

  /**
   * Synchronous entry point — Signal K's plugin.start() is synchronous, so
   * the async work runs under the helper's startSafely.
   */
  start(settings: StreamSettings): void {
    this.settings = settings;
    this.running = true;
    this.consecutiveFailures = 0;
    this.lastHealth = null;
    this.lastStatusLine = "";
    const token = ++this.runToken;
    startSafely(this.app, () => this.run(token));
  }

  /** Async — Signal K awaits plugin.stop(). Never throws. */
  async stop(): Promise<void> {
    this.running = false;
    this.runToken++; // invalidates any in-flight run/gate/health work
    this.stopHealthLoop();
    this.status = "stopped";
    try {
      await this.container.stop();
    } catch (err) {
      this.app.debug(`container stop failed: ${errMsg(err)}`);
    }
    this.app.setPluginStatus("Stopped");
  }

  async statusReport(): Promise<StatusReport> {
    return {
      status: this.status,
      tag: this.container.lastStartedTag ?? this.settings.imageTag,
      containerState: await this.container.getState(),
      lastHealth: this.lastHealth,
      streamPort: this.settings.port,
      touchPort: this.settings.touchPort,
    };
  }

  /**
   * Called after a successful container update (POST /api/update/apply):
   * applyUpdate recreated the container — re-run the readiness gate and
   * restart the health loop.
   */
  onUpdateApplied(): void {
    if (!this.running) return;
    const token = ++this.runToken; // supersede the old gate/health loop
    this.stopHealthLoop();
    this.consecutiveFailures = 0;
    startSafely(this.app, () => this.gateAndWatch(token));
  }

  // ---------------------------------------------------------------------
  // Startup sequence
  // ---------------------------------------------------------------------

  private active(token: number): boolean {
    return this.running && token === this.runToken;
  }

  private requireProfile(): ProfileMount {
    if (this.profile === null) {
      throw new Error(
        "chromium profile mount is not resolved yet — buildConfig called " +
          "before run()?",
      );
    }
    return this.profile;
  }

  private async run(token: number): Promise<void> {
    this.status = "starting";
    this.app.setPluginStatus("Waiting for signalk-container...");

    // The profile mount needs the manager in hand BEFORE the container
    // config can be built (resolveMount translates our data-dir path into
    // something the host runtime can bind, containerized Signal K included).
    const { manager } = await waitForContainerManager({
      timeoutMs: this.timing.managerTimeoutMs,
    });
    if (!this.active(token)) return;
    if (manager === undefined) {
      const msg =
        "signalk-container is not installed or not enabled — it manages " +
        "the capture container and is required";
      this.app.setPluginError(msg);
      this.status = "error";
      throw new Error(msg);
    }

    const profileHostPath = join(this.app.getDataDirPath(), "chromium-profile");
    try {
      await mkdir(profileHostPath, { recursive: true });
    } catch (err) {
      this.app.debug(`could not pre-create profile dir: ${errMsg(err)}`);
    }
    const mount = await resolveMount(manager, {
      containerPath: PROFILE_CONTAINER_PATH,
      hostPath: profileHostPath,
    });
    if (!this.active(token)) return;
    this.profile = { source: mount.source, containerPath: mount.containerPath };

    const { tag } = await this.container.start(this.settings.imageTag);
    if (!this.active(token)) return;
    this.app.debug(`container started with ${IMAGE}:${tag}`);
    await this.gateAndWatch(token);
  }

  /** Readiness gate on /health, then the recurring health loop. */
  private async gateAndWatch(token: number): Promise<void> {
    this.status = "starting";
    this.setStatusLine(
      "Starting the capture chain (Xvfb + Chromium + ffmpeg)...",
    );
    const url = healthUrl(this.settings.advanced.healthPort);
    try {
      await waitForHttpReady(url, {
        maxMs: this.timing.readyMaxMs,
        intervalMs: this.timing.readyIntervalMs,
        requestTimeoutMs: 2_000,
      });
    } catch (err) {
      if (!this.active(token)) return;
      const seconds = Math.round(this.timing.readyMaxMs / 1000);
      this.app.setPluginError(
        `capture container did not answer on ${url} within ${seconds}s: ` +
          `${errMsg(err)} — health loop keeps probing`,
      );
      this.status = "error";
      // Keep probing: the health loop's success path recovers to ready.
      this.startHealthLoop(token);
      return;
    }
    if (!this.active(token)) return;
    this.status = "ready";
    this.consecutiveFailures = 0;
    this.setStatusLine(
      `Ready — waiting for the panel to connect (TCP ${this.settings.port})`,
    );
    this.startHealthLoop(token);
  }

  // ---------------------------------------------------------------------
  // Health loop
  // ---------------------------------------------------------------------

  private startHealthLoop(token: number): void {
    this.stopHealthLoop();
    this.healthTimer = setInterval(() => {
      void this.healthTick(token);
    }, this.timing.healthIntervalMs);
    sleepFree(this.healthTimer);
  }

  private stopHealthLoop(): void {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async healthTick(token: number): Promise<void> {
    if (!this.active(token) || this.probeInFlight) return;
    this.probeInFlight = true;
    try {
      const payload = await fetchHealth(
        this.settings.advanced.healthPort,
        this.timing.healthTimeoutMs,
      );
      if (!this.active(token)) return;
      this.lastHealth = { ok: true, at: Date.now(), payload };
      this.consecutiveFailures = 0;
      if (this.status === "error") this.app.debug("capture chain recovered");
      this.status = "ready";
      this.setStatusLine(describeHealth(payload, this.settings));
    } catch (err) {
      if (!this.active(token)) return;
      const reason = errMsg(err);
      this.lastHealth = {
        ok: false,
        at: Date.now(),
        payload: null,
        error: reason,
      };
      this.consecutiveFailures++;
      this.app.debug(
        `health probe failed (${this.consecutiveFailures} in a row): ${reason}`,
      );
      if (
        this.consecutiveFailures >= this.timing.healthFailThreshold &&
        this.status !== "error"
      ) {
        this.status = "error";
        this.lastStatusLine = ""; // an eventual recovery re-prints
        this.app.setPluginError(
          `capture container is not answering its health endpoint ` +
            `(${this.consecutiveFailures} consecutive failures): ${reason}`,
        );
      }
    } finally {
      this.probeInFlight = false;
    }
  }

  /** Boolean probe for signalk-container's recurring healthCheck hook. */
  private async quickProbe(): Promise<boolean> {
    try {
      const payload = await fetchHealth(
        this.settings.advanced.healthPort,
        this.timing.healthTimeoutMs,
      );
      return payload.chainAlive;
    } catch {
      return false;
    }
  }

  /** setPluginStatus only on change — the health loop ticks every 10 s. */
  private setStatusLine(line: string): void {
    if (line === this.lastStatusLine) return;
    this.lastStatusLine = line;
    this.app.setPluginStatus(line);
  }
}

/** Human status line from a health payload. */
export function describeHealth(
  payload: HealthPayload,
  settings: StreamSettings,
): string {
  if (!payload.chainAlive) {
    return "Capture chain died — the container restarts it automatically";
  }
  if (payload.client === null) {
    return `Ready — waiting for the panel to connect (TCP ${settings.port})`;
  }
  return (
    `Streaming ${settings.width}x${settings.height} to ${payload.client} ` +
    `@ ${payload.fps.toFixed(1)} fps, ${Math.round(payload.kbps)} KB/s`
  );
}
