/**
 * Typed access to the capture container's loopback /health endpoint —
 * the only readiness/health signal. NEVER probe the stream TCP port for
 * health: the capture server accepts exactly one client at a time, so a
 * probe connection would be served as the panel and lock it out for a full
 * ACK-timeout window.
 */

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { fetchWithTimeout } from "signalk-container-helper";

export const HealthSchema = Type.Object({
  chainAlive: Type.Boolean(),
  client: Type.Union([Type.String(), Type.Null()]),
  framesSent: Type.Integer(),
  fps: Type.Number(),
  kbps: Type.Number(),
  uptimeS: Type.Number(),
});

export type HealthPayload = Static<typeof HealthSchema>;

export function healthUrl(healthPort: number): string {
  return `http://127.0.0.1:${healthPort}/health`;
}

/** Fetch and validate /health; throws on network error or malformed body. */
export async function fetchHealth(
  port: number,
  timeoutMs: number,
): Promise<HealthPayload> {
  const response = await fetchWithTimeout(healthUrl(port), { timeoutMs });
  if (!response.ok) {
    throw new Error(`health endpoint answered HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const converted = Value.Convert(HealthSchema, body);
  if (!Value.Check(HealthSchema, converted)) {
    throw new Error("health endpoint returned an unexpected payload");
  }
  return converted;
}
