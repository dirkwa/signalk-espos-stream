import { describe, expect, it } from "vitest";
import {
  applyDefaults,
  buildContainerConfig,
  defaultSettings,
  IMAGE,
  isSemverTag,
  OWN_VERSION,
  resolveTag,
  type ProfileMount,
} from "../src/config.js";

const PROFILE: ProfileMount = {
  source:
    "/home/user/.signalk/plugin-config-data/signalk-espos-stream/chromium-profile",
  containerPath: "/profile",
};

describe("applyDefaults", () => {
  it("returns full defaults for empty/absent config", () => {
    expect(applyDefaults(undefined)).toEqual(defaultSettings());
    expect(applyDefaults({})).toEqual(defaultSettings());
    expect(applyDefaults(null)).toEqual(defaultSettings());
    expect(applyDefaults("nonsense")).toEqual(defaultSettings());
  });

  it("keeps valid overrides", () => {
    const settings = applyDefaults({
      captureUrl: "http://localhost:80/@signalk/kip/",
      width: 720,
      height: 720,
      fps: 10,
      advanced: { memoryLimit: "1536m" },
    });
    expect(settings.captureUrl).toBe("http://localhost:80/@signalk/kip/");
    expect(settings.width).toBe(720);
    expect(settings.height).toBe(720);
    expect(settings.fps).toBe(10);
    expect(settings.advanced.memoryLimit).toBe("1536m");
    // untouched fields fall back to defaults
    expect(settings.port).toBe(5004);
    expect(settings.advanced.healthPort).toBe(5006);
  });

  it("converts stringly-typed numbers (hand-edited config files)", () => {
    const settings = applyDefaults({ fps: "12", port: "5014" });
    expect(settings.fps).toBe(12);
    expect(settings.port).toBe(5014);
  });

  it("resets invalid fields individually, keeping the valid rest", () => {
    const settings = applyDefaults({
      fps: 1000, // above maximum
      quality: 1, // below minimum
      captureUrl: "http://ok.example/",
    });
    expect(settings.fps).toBe(15);
    expect(settings.quality).toBe(6);
    expect(settings.captureUrl).toBe("http://ok.example/");
  });

  it("recovers from a non-object advanced section", () => {
    const settings = applyDefaults({ advanced: "broken", port: 5014 });
    expect(settings.advanced).toEqual(defaultSettings().advanced);
    expect(settings.port).toBe(5014);
  });
});

describe("resolveTag", () => {
  it("maps auto to the plugin's own version", () => {
    expect(resolveTag("auto")).toBe(OWN_VERSION);
    expect(isSemverTag(OWN_VERSION)).toBe(true);
  });

  it("passes explicit tags through", () => {
    expect(resolveTag("dev")).toBe("dev");
    expect(resolveTag("0.0.9")).toBe("0.0.9");
  });
});

describe("buildContainerConfig", () => {
  it("is deterministic for identical inputs (drift stability)", () => {
    const settings = defaultSettings();
    const a = buildContainerConfig(settings, "0.1.0", PROFILE);
    const b = buildContainerConfig(settings, "0.1.0", PROFILE);
    expect(a).toEqual(b);
  });

  it("uses host networking and never port declarations", () => {
    const config = buildContainerConfig(defaultSettings(), "0.1.0", PROFILE);
    expect(config.networkMode).toBe("host");
    expect(config).not.toHaveProperty("ports");
    expect(config).not.toHaveProperty("signalkAccessiblePorts");
  });

  it("always emits the full command array", () => {
    const config = buildContainerConfig(defaultSettings(), "0.1.0", PROFILE);
    const command = config.command ?? [];
    expect(command).toContain("--url");
    expect(command).toContain("--wait-url");
    expect(command).toContain("--profile");
    expect(command[command.indexOf("--profile") + 1]).toBe("/profile");
    expect(command[command.indexOf("--touch") + 1]).toBe("on");
    expect(command).not.toContain("--disable-dev-shm");
  });

  it("reflects touch/disableDevShm settings in the command", () => {
    const settings = defaultSettings();
    settings.touch = false;
    settings.advanced.disableDevShm = true;
    const command =
      buildContainerConfig(settings, "0.1.0", PROFILE).command ?? [];
    expect(command[command.indexOf("--touch") + 1]).toBe("off");
    expect(command).toContain("--disable-dev-shm");
  });

  it("binds the profile and the host /dev/shm", () => {
    const config = buildContainerConfig(defaultSettings(), "0.1.0", PROFILE);
    expect(config.volumes).toEqual({
      "/profile": { source: PROFILE.source, ifMissing: "create" },
      "/dev/shm": { source: "/dev/shm", ifMissing: "abort" },
    });
    expect(config.image).toBe(IMAGE);
  });
});
