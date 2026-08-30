import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/config.js";
import { describeHealth } from "../src/service.js";
import type { HealthPayload } from "../src/health.js";

function payload(overrides: Partial<HealthPayload> = {}): HealthPayload {
  return {
    chainAlive: true,
    client: null,
    framesSent: 0,
    fps: 0,
    kbps: 0,
    uptimeS: 12,
    ...overrides,
  };
}

describe("describeHealth", () => {
  it("reports a dead capture chain", () => {
    expect(
      describeHealth(payload({ chainAlive: false }), defaultSettings()),
    ).toMatch(/died/);
  });

  it("reports waiting with the stream port when no client is connected", () => {
    expect(describeHealth(payload(), defaultSettings())).toContain("5004");
  });

  it("reports the client, fps and throughput while streaming", () => {
    const line = describeHealth(
      payload({ client: "192.168.0.118", fps: 14.72, kbps: 412.4 }),
      defaultSettings(),
    );
    expect(line).toContain("192.168.0.118");
    expect(line).toContain("14.7 fps");
    expect(line).toContain("412 KB/s");
    expect(line).toContain("1024x600");
  });
});
