/**
 * Custom plugin-config panel for the Signal K Admin UI, built on the shared
 * signalk-container-helper/ui building blocks with a zustand form store.
 * Replaces the JSON-schema auto-form (which remains the fallback on servers
 * without panel support): live container/stream status card, image update
 * check/apply, a GitHub-releases version dropdown fed by /api/versions, and
 * the capture/geometry/port settings with a collapsed advanced section.
 *
 * Loaded as a webpack Module Federation remote; `react` resolves to the
 * Admin UI's shared singleton.
 */

import { useEffect } from "react";
import {
  panelStyles as S,
  SectionTitle,
  StatusCard,
  FieldRow,
  VersionSelect,
  UpdateControls,
  CollapsibleSection,
  ActionStatus,
  Button,
  useStatusPoll,
  useVersions,
} from "signalk-container-helper/ui";
import { DEFAULTS, toInt, useFormStore } from "./store";

const BASE = "/plugins/signalk-espos-stream";

interface HealthPayload {
  chainAlive: boolean;
  client: string | null;
  framesSent: number;
  fps: number;
  kbps: number;
  uptimeS: number;
}

interface StatusReport {
  status?: string;
  tag?: string;
  containerState?: string;
  streamPort?: number;
  touchPort?: number;
  lastHealth?: {
    ok: boolean;
    payload: HealthPayload | null;
    error?: string;
  } | null;
}

interface PanelProps {
  configuration?: unknown;
  save(configuration: unknown): void;
}

function describeStatus(
  loading: boolean,
  report: StatusReport,
): {
  state: "ok" | "warn" | "error";
  meta: string;
  title: string;
} {
  const st = typeof report.status === "string" ? report.status : "not_running";
  if (loading) return { state: "warn", meta: "Checking...", title: st };
  if (st === "ready") {
    const payload = report.lastHealth?.payload ?? null;
    // A dead capture chain outranks client state: without it "waiting for
    // the panel" would show an OK card while nothing can stream.
    if (payload !== null && !payload.chainAlive) {
      return {
        state: "warn",
        title: st,
        meta: "Capture chain died — the container restarts it automatically",
      };
    }
    if (payload !== null && payload.client !== null) {
      return {
        state: "ok",
        title: st,
        meta:
          `Streaming to ${payload.client} @ ${payload.fps.toFixed(1)} fps, ` +
          `${Math.round(payload.kbps)} KB/s`,
      };
    }
    return {
      state: "ok",
      title: st,
      meta: `Ready — waiting for the panel (TCP ${report.streamPort ?? "?"})`,
    };
  }
  if (st === "starting") {
    return {
      state: "warn",
      title: st,
      meta: "Starting the capture chain (Xvfb + Chromium + ffmpeg)...",
    };
  }
  if (st === "error") {
    return {
      state: "error",
      title: st,
      meta: report.lastHealth?.error ?? "Capture container is not answering",
    };
  }
  return { state: "error", title: st, meta: "Not running" };
}

export default function PluginConfigurationPanel({
  configuration,
  save,
}: PanelProps) {
  const form = useFormStore();

  // Hydrate once from the saved configuration prop on mount (deliberately
  // no deps: later prop churn must not clobber the user's draft).
  useEffect(() => {
    form.hydrate(configuration);
  }, []);

  const { status, loading, refresh } = useStatusPoll<StatusReport>(
    `${BASE}/api/status`,
    { fallback: { status: "not_running" } },
  );
  const versions = useVersions(`${BASE}/api/versions`);

  const view = describeStatus(loading, status ?? { status: "not_running" });
  const st = typeof status?.status === "string" ? status.status : "not_running";

  const doSave = () => {
    save({
      captureUrl: form.captureUrl.trim() || DEFAULTS.captureUrl,
      authToken: form.authToken.trim(),
      imageTag: form.imageTag.trim() || DEFAULTS.imageTag,
      width: toInt(form.width, 1024),
      height: toInt(form.height, 600),
      fps: toInt(form.fps, 15),
      quality: toInt(form.quality, 6),
      port: toInt(form.port, 5004),
      touchPort: toInt(form.touchPort, 5005),
      touch: form.touch,
      advanced: {
        healthPort: toInt(form.healthPort, 5006),
        memoryLimit: form.memoryLimit.trim() || DEFAULTS.memoryLimit,
        restartPolicy: form.restartPolicy,
        disableDevShm: form.disableDevShm,
      },
    });
    form.markSaved(
      "Saved. Signal K restarts the plugin with the new configuration.",
    );
  };

  return (
    <div style={S.root}>
      <SectionTitle>Stream status</SectionTitle>
      <StatusCard
        icon="S"
        iconBackground={view.state === "ok" ? "#0e7490" : undefined}
        title="espOS Display Stream"
        meta={view.meta}
        state={view.state}
        stateTitle={view.title}
      />

      {/* Check/apply against the routes registerUpdateRoutes mounts; hidden
          while the plugin is disabled (they answer 503 then anyway). */}
      {st !== "not_running" && st !== "stopped" && (
        <UpdateControls
          checkUrl={`${BASE}/api/update/check`}
          applyUrl={`${BASE}/api/update/apply`}
          tag={form.imageTag}
          onApplied={() => void refresh()}
        />
      )}

      <SectionTitle>Capture</SectionTitle>
      <FieldRow
        label="Capture URL"
        hint="page the kiosk renders — host networking, so localhost is this machine"
      />
      <input
        style={{ ...S.input, width: "100%", marginBottom: 10 }}
        value={form.captureUrl}
        onChange={(e) => form.patch({ captureUrl: e.target.value })}
        placeholder={DEFAULTS.captureUrl}
      />
      <FieldRow
        label="Access token"
        hint="appended as ?token= — Freeboard-SK logs in with it and never shows the login dialog"
      >
        <input
          style={{ ...S.input, width: "100%" }}
          type="password"
          value={form.authToken}
          onChange={(e) => form.patch({ authToken: e.target.value })}
          placeholder="empty = no kiosk login"
        />
      </FieldRow>
      <FieldRow label="Geometry" hint="match the panel's display resolution">
        <input
          style={{ ...S.input, width: 70 }}
          type="number"
          value={form.width}
          onChange={(e) => form.patch({ width: e.target.value })}
        />
        <span style={{ margin: "0 6px" }}>x</span>
        <input
          style={{ ...S.input, width: 70 }}
          type="number"
          value={form.height}
          onChange={(e) => form.patch({ height: e.target.value })}
        />
      </FieldRow>
      <FieldRow
        label="Frame rate"
        hint="ceiling only — the panel self-paces via ACKs"
      >
        <input
          style={{ ...S.input, width: 70 }}
          type="number"
          value={form.fps}
          onChange={(e) => form.patch({ fps: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="JPEG quality" hint="ffmpeg -q:v 2..31 — lower is better">
        <input
          style={{ ...S.input, width: 70 }}
          type="number"
          value={form.quality}
          onChange={(e) => form.patch({ quality: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="Image version">
        <VersionSelect
          value={form.imageTag}
          onChange={(tag: string) => form.patch({ imageTag: tag })}
          versions={versions.versions}
          floatingOptions={[
            {
              tag: "auto",
              label: "auto (matches plugin version, recommended)",
            },
            { tag: "dev", label: "dev (locally built image)" },
          ]}
          loading={versions.loading}
          error={versions.versionsError}
          onRefresh={versions.refresh}
        />
      </FieldRow>

      <SectionTitle>Panel connection</SectionTitle>
      <FieldRow label="Stream port" hint="TCP — the panel's stream widget port">
        <input
          style={{ ...S.input, width: 90 }}
          type="number"
          value={form.port}
          onChange={(e) => form.patch({ port: e.target.value })}
        />
      </FieldRow>
      <FieldRow
        label="Touch port"
        hint="UDP — only the connected stream client's packets are injected"
      >
        <input
          style={{ ...S.input, width: 90 }}
          type="number"
          value={form.touchPort}
          onChange={(e) => form.patch({ touchPort: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="Touch injection">
        <input
          type="checkbox"
          checked={form.touch}
          onChange={(e) => form.patch({ touch: e.target.checked })}
        />
      </FieldRow>

      <CollapsibleSection title="Advanced">
        <FieldRow
          label="Health port"
          hint="loopback-only HTTP health endpoint inside the container"
        >
          <input
            style={{ ...S.input, width: 90 }}
            type="number"
            value={form.healthPort}
            onChange={(e) => form.patch({ healthPort: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="Memory limit" hint='hard cap, e.g. "1g" or "1536m"'>
          <input
            style={{ ...S.input, width: 90 }}
            value={form.memoryLimit}
            onChange={(e) => form.patch({ memoryLimit: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="Restart policy">
          <select
            style={S.select}
            value={form.restartPolicy}
            onChange={(e) => form.patch({ restartPolicy: e.target.value })}
          >
            <option value="unless-stopped">unless-stopped</option>
            <option value="always">always</option>
            <option value="no">no</option>
          </select>
        </FieldRow>
        <FieldRow
          label="Disable /dev/shm"
          hint="fallback if the host /dev/shm bind misbehaves — Chromium uses /tmp instead"
        >
          <input
            type="checkbox"
            checked={form.disableDevShm}
            onChange={(e) => form.patch({ disableDevShm: e.target.checked })}
          />
        </FieldRow>
      </CollapsibleSection>

      <div style={{ marginTop: 24 }}>
        <Button onClick={doSave}>Save Configuration</Button>
      </div>
      <ActionStatus message={form.savedMessage} />
    </div>
  );
}
