/**
 * signalk-espos-stream — browser-rendered dashboard streaming for espOS
 * panels (ESP32-P4 cockpit displays).
 *
 * Runs the capture chain (Xvfb + Chromium kiosk + ffmpeg) in a container
 * managed via signalk-container (through signalk-container-helper). The
 * container serves the panel's `stream` widget directly: ACK-paced MJPEG
 * over TCP ([u32 BE length][baseline JPEG], 1-byte ACK per displayed frame)
 * and an XTEST touch backchannel over UDP (LE u16 x, u16 y, u8 type),
 * gated to the connected stream client's source IP.
 */

import type { Plugin, ServerAPI } from "@signalk/server-api";
import {
  errMsg,
  fetchWithTimeout,
  type RouterLike,
} from "signalk-container-helper";
import {
  applyDefaults,
  GITHUB_REPO,
  PLUGIN_ID,
  PLUGIN_NAME,
  isSemverTag,
  SettingsSchema,
} from "./config.js";
import { ServiceRunner, type RunnerTiming } from "./service.js";

export type { RunnerTiming };
export { ServiceRunner };

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}

type Handler = (req: unknown, res: ResponseLike) => unknown;

interface PluginRouter {
  get(path: string, handler: Handler): unknown;
  post(path: string, handler: Handler): unknown;
  /** Permission registrar (Signal K ≥ 2.x); feature-detect. */
  access?(level: "readonly" | "readwrite"): PluginRouter;
}

const RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=25`;

/** Numeric-descending compare for the plain x.y.z tags isSemverTag admits. */
function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export default function createPlugin(app: ServerAPI): Plugin {
  let runner: ServiceRunner | undefined;
  let lastConfig: Record<string, unknown> = {};

  // Constructed lazily and kept for the process lifetime: registerWithRouter
  // is called even when the plugin is disabled, and Express routes cannot be
  // deregistered — the single runner instance is what the persistent routes
  // delegate to. Construction is side-effect free.
  const getRunner = (): ServiceRunner => {
    runner ??= new ServiceRunner(app);
    return runner;
  };

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description:
      "Streams a browser-rendered Signal K dashboard to an espOS panel as " +
      "ACK-paced MJPEG with a touch backchannel, from a managed container.",

    // TypeBox emits plain JSON schema — the Admin UI form renders it as-is.
    schema: () => SettingsSchema as unknown as object,

    start(config: object) {
      lastConfig = (config ?? {}) as Record<string, unknown>;
      getRunner().start(applyDefaults(lastConfig));
    },

    // Async and awaited by the server: the next start() (e.g. on config
    // change) does not run until the container has actually stopped.
    async stop() {
      await runner?.stop();
    },

    registerWithRouter(router: unknown) {
      const r = getRunner();
      const pluginRouter = router as PluginRouter;

      // registerWithRouter outlives stop(): every handler is guarded by the
      // running flag so routes answer 503 instead of acting on a stopped
      // (or never-started) plugin.
      const guard =
        (handler: Handler): Handler =>
        (req, res) => {
          if (!r.isRunning) {
            res
              .status(503)
              .json({ error: "signalk-espos-stream is not running" });
            return;
          }
          return handler(req, res);
        };

      // Container update routes (admin-only by default — correct):
      // GET  /plugins/signalk-espos-stream/api/update/check
      // POST /plugins/signalk-espos-stream/api/update/apply
      const guardedRouter: RouterLike = {
        get: (path, handler) => pluginRouter.get(path, guard(handler)),
        post: (path, handler) => pluginRouter.post(path, guard(handler)),
      };
      r.container.registerUpdateRoutes(guardedRouter, {
        onApplied: (requestedTag) => {
          // Persist the REQUESTED tag (e.g. "auto") so auto-tracking
          // survives restarts.
          lastConfig = { ...lastConfig, imageTag: requestedTag };
          app.savePluginOptions(lastConfig, (err) => {
            if (err) {
              app.error(`failed to persist updated image tag: ${errMsg(err)}`);
            }
          });
          // The recreate replaced the container: re-run the readiness gate
          // and restart the health loop.
          r.onUpdateApplied();
        },
      });

      // Readonly routes — any authenticated user when the server supports
      // route permissions, admin-only otherwise.
      const readonlyRouter =
        typeof pluginRouter.access === "function"
          ? pluginRouter.access("readonly")
          : pluginRouter;

      // GET /plugins/signalk-espos-stream/api/status
      readonlyRouter.get(
        "/api/status",
        guard(async (_req, res) => {
          try {
            res.json(await r.statusReport());
          } catch (err) {
            res.status(500).json({ error: errMsg(err) });
          }
        }),
      );

      // GET /plugins/signalk-espos-stream/api/versions — the config panel's
      // version-dropdown feed (GitHub releases; image tags are published in
      // lockstep). Deliberately NOT guarded by the running flag: the
      // operator picks a tag while the plugin is still disabled.
      readonlyRouter.get("/api/versions", (_req, res) => {
        void (async () => {
          try {
            const response = await fetchWithTimeout(RELEASES_URL, {
              timeoutMs: 10_000,
            });
            if (!response.ok) {
              res
                .status(502)
                .json({ error: `GitHub answered HTTP ${response.status}` });
              return;
            }
            const body: unknown = await response.json();
            const versions = (Array.isArray(body) ? body : [])
              .map((entry: unknown) =>
                typeof entry === "object" &&
                entry !== null &&
                "tag_name" in entry &&
                typeof (entry as { tag_name: unknown }).tag_name === "string"
                  ? (entry as { tag_name: string }).tag_name.replace(/^v/, "")
                  : "",
              )
              .filter(isSemverTag)
              .sort(compareSemverDesc)
              .map((tag) => ({ tag }));
            res.json({ versions });
          } catch (err) {
            res.status(502).json({ error: errMsg(err) });
          }
        })();
      });
    },
  };

  return plugin;
}
