/**
 * signalk-espos-stream configuration: TypeBox settings schema, defaults, and
 * the pure settings → ContainerConfig mapping consumed by
 * signalk-container-helper.
 *
 * The container runs with host networking on purpose:
 * - the capture URL default `http://localhost:80/...` keeps working whether
 *   Signal K is bare-metal or itself a host-network container,
 * - the panel-facing MJPEG (TCP) and touch (UDP) ports bind directly on the
 *   host exactly like the pre-container systemd service did,
 * - the touch injector's source-IP gate sees the panel's real address
 *   (rootless bridge NAT would rewrite it).
 * With `networkMode` set, `ports`/`signalkAccessiblePorts` must NOT be used.
 */

import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ContainerConfig } from "signalk-container-helper";

export const PLUGIN_ID = "signalk-espos-stream";
export const PLUGIN_NAME = "espOS Display Stream";
/** Unprefixed container name; runs as `sk-espos-stream` on the host runtime. */
export const CONTAINER_NAME = "espos-stream";
export const IMAGE = "ghcr.io/dirkwa/signalk-espos-stream";
/** GitHub repo backing both the npm package and the container image. */
export const GITHUB_REPO = "dirkwa/signalk-espos-stream";
/** X display inside the container — private namespace, never collides. */
export const CONTAINER_DISPLAY = ":99";
/** Chromium profile mount point inside the container. */
export const PROFILE_CONTAINER_PATH = "/profile";

/**
 * The plugin's own version. `imageTag: "auto"` resolves to it: the container
 * image is published in lockstep with the npm package by the release CI, so
 * the plugin version IS the tested image tag (signalk-backup's model, not
 * signalk-whisper's upstream-pin model).
 */
export const OWN_VERSION: string = (() => {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof raw === "object" &&
    raw !== null &&
    "version" in raw &&
    typeof (raw as { version: unknown }).version === "string"
  ) {
    return (raw as { version: string }).version;
  }
  throw new Error("package.json has no version field");
})();

const advancedProperties = {
  healthPort: Type.Integer({
    title: "Health port",
    default: 5006,
    minimum: 1,
    maximum: 65535,
    description:
      "Loopback HTTP port inside the capture container reporting chain " +
      "health and throughput. Only this plugin talks to it.",
  }),
  memoryLimit: Type.String({
    title: "Memory limit",
    default: "1g",
    description:
      "Hard container memory cap (docker syntax, e.g. 1g, 1536m). Chromium " +
      "peaks around 500 MB at 1024x600 — keep at least 768m of headroom.",
  }),
  restartPolicy: Type.Union(
    [
      Type.Literal("no"),
      Type.Literal("unless-stopped"),
      Type.Literal("always"),
    ],
    {
      title: "Restart policy",
      default: "unless-stopped",
      description:
        "Container runtime restart policy. The capture server exits " +
        "non-zero when the capture chain dies, so anything but 'no' " +
        "relaunches the whole stack automatically.",
    },
  ),
  disableDevShm: Type.Boolean({
    title: "Disable /dev/shm in Chromium",
    default: false,
    description:
      "Fallback: pass --disable-dev-shm-usage to Chromium (shared memory " +
      "goes to /tmp). Only needed if the host /dev/shm bind mount " +
      "misbehaves on your runtime.",
  }),
};

// `default: {}` is load-bearing: without an object-level default,
// Value.Default never materializes a missing `advanced` section and every
// partial config would fail validation wholesale.
export const AdvancedSchema = Type.Object(advancedProperties, {
  title: "Advanced",
  default: {},
});

export const SettingsSchema = Type.Object({
  captureUrl: Type.String({
    title: "Capture URL",
    default: "http://localhost:80/@signalk/freeboard-sk/",
    description:
      "Page the kiosk Chromium renders and streams — Freeboard-SK, KIP, or " +
      "any URL. The container uses host networking, so 'localhost' is this " +
      "machine.",
  }),
  imageTag: Type.String({
    title: "Image tag",
    default: "auto",
    description:
      `Tag for ${IMAGE}. 'auto' runs the image released in lockstep with ` +
      "this plugin version — the tested combination. Set an explicit tag " +
      "(e.g. 'dev' for a locally built image) only when you know why.",
  }),
  width: Type.Integer({
    title: "Width",
    default: 1024,
    minimum: 64,
    maximum: 4096,
    description: "Stream width in pixels — match the panel's display.",
  }),
  height: Type.Integer({
    title: "Height",
    default: 600,
    minimum: 64,
    maximum: 4096,
    description: "Stream height in pixels — match the panel's display.",
  }),
  fps: Type.Integer({
    title: "Frame rate ceiling",
    default: 15,
    minimum: 1,
    maximum: 60,
    description:
      "ffmpeg capture rate. The panel self-paces below this via the ACK " +
      "protocol, so higher values only cost server CPU.",
  }),
  quality: Type.Integer({
    title: "JPEG quality",
    default: 6,
    minimum: 2,
    maximum: 31,
    description: "ffmpeg -q:v — LOWER is better quality and bigger frames.",
  }),
  port: Type.Integer({
    title: "Stream port (TCP)",
    default: 5004,
    minimum: 1,
    maximum: 65535,
    description:
      "Host TCP port the panel's stream widget connects to " +
      "([u32 length][JPEG], 1-byte ACK per frame).",
  }),
  touchPort: Type.Integer({
    title: "Touch port (UDP)",
    default: 5005,
    minimum: 1,
    maximum: 65535,
    description:
      "Host UDP port for the panel's touch packets. Only packets from the " +
      "connected stream client's IP are injected.",
  }),
  touch: Type.Boolean({
    title: "Touch injection",
    default: true,
    description:
      "Inject the panel's touch events into the kiosk page via XTEST.",
  }),
  advanced: AdvancedSchema,
});

export type AdvancedSettings = Static<typeof AdvancedSchema>;
export type StreamSettings = Static<typeof SettingsSchema>;

export function defaultSettings(): StreamSettings {
  // Value.Default (not Value.Create): Create would take AdvancedSchema's
  // object-level `default: {}` verbatim instead of descending into the
  // per-field defaults.
  const value = Value.Clean(SettingsSchema, Value.Default(SettingsSchema, {}));
  if (!Value.Check(SettingsSchema, value)) {
    throw new Error("SettingsSchema defaults do not satisfy the schema");
  }
  return value;
}

/**
 * Merge raw plugin config over the defaults. Signal K does NOT seed schema
 * defaults into saved configurations, and hand-edited config files can hold
 * anything — invalid fields fall back to their defaults individually, the
 * rest of the config survives.
 */
export function applyDefaults(raw: unknown): StreamSettings {
  const candidate = Value.Clean(
    SettingsSchema,
    Value.Convert(
      SettingsSchema,
      Value.Default(SettingsSchema, Value.Clone(raw ?? {})),
    ),
  );
  if (Value.Check(SettingsSchema, candidate)) return candidate;

  const fallback = defaultSettings();
  if (typeof candidate !== "object" || candidate === null) return fallback;
  const repaired = candidate as Record<string, unknown>;
  for (const error of Value.Errors(SettingsSchema, repaired)) {
    // Reset the top-level field owning the errored path to its default.
    const field = error.instancePath.split("/")[1];
    if (field !== undefined && field in fallback) {
      repaired[field] = fallback[field as keyof StreamSettings];
    }
  }
  // Root-level errors (e.g. a missing required field) have no path segment
  // to repair — fill any still-missing top-level keys from the defaults.
  for (const key of Object.keys(fallback) as (keyof StreamSettings)[]) {
    if (!(key in repaired)) repaired[key] = fallback[key];
  }
  return Value.Check(SettingsSchema, repaired) ? repaired : fallback;
}

/** Maps the user-facing tag to the tag actually run: "auto" → own version. */
export function resolveTag(requested: string): string {
  return requested === "auto" ? OWN_VERSION : requested;
}

/** True for plain numeric semver tags like "0.1.0" (update-check filter). */
export function isSemverTag(tag: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(tag);
}

/** Host-side chromium-profile bind resolved before the container starts. */
export interface ProfileMount {
  /** Host source path (or named-volume) — the `volumes` value. */
  source: string;
  /** Path inside the container to hand to --profile (subPath included). */
  containerPath: string;
}

/**
 * Pure, deterministic settings → ContainerConfig mapping. Called on every
 * start/update; the `command` array is always fully present and stable so
 * signalk-container's drift detection never recreate-loops.
 */
export function buildContainerConfig(
  settings: StreamSettings,
  tag: string,
  profile: ProfileMount,
): ContainerConfig {
  const adv = settings.advanced;
  const command = [
    "--url",
    settings.captureUrl,
    "--port",
    String(settings.port),
    "--touch-port",
    String(settings.touchPort),
    "--fps",
    String(settings.fps),
    "--quality",
    String(settings.quality),
    "--width",
    String(settings.width),
    "--height",
    String(settings.height),
    "--display",
    CONTAINER_DISPLAY,
    "--profile",
    profile.containerPath,
    "--health-port",
    String(adv.healthPort),
    "--wait-url",
    "--touch",
    settings.touch ? "on" : "off",
    ...(adv.disableDevShm ? ["--disable-dev-shm"] : []),
  ];
  return {
    image: IMAGE,
    tag,
    command,
    networkMode: "host",
    volumes: {
      [PROFILE_CONTAINER_PATH]: { source: profile.source, ifMissing: "create" },
      // Host /dev/shm (4 GB tmpfs on a stock Pi) instead of podman's 64 MB
      // default: signalk-container cannot express --shm-size, and Chromium
      // without real shared memory either crashes tabs or falls back to
      // SD-card-backed /tmp.
      "/dev/shm": { source: "/dev/shm", ifMissing: "abort" },
    },
    restart: adv.restartPolicy,
    resources: {
      memory: adv.memoryLimit,
      memorySwap: adv.memoryLimit,
    },
  };
}
