/**
 * zustand store for the config panel's form draft. Numeric fields are held
 * as strings (they back <input> elements) and converted on save; defaults
 * mirror ../config.ts — the panel bundle cannot import the Node-only server
 * code.
 */

import { create } from "zustand";

export interface FormState {
  captureUrl: string;
  imageTag: string;
  width: string;
  height: string;
  fps: string;
  quality: string;
  port: string;
  touchPort: string;
  touch: boolean;
  healthPort: string;
  memoryLimit: string;
  restartPolicy: string;
  disableDevShm: boolean;
  savedMessage: string;
  hydrated: boolean;
}

export interface FormActions {
  hydrate(configuration: unknown): void;
  patch(update: Partial<FormState>): void;
  markSaved(message: string): void;
}

/** Mirrors defaultSettings() in ../config.ts. */
export const DEFAULTS: Omit<FormState, "savedMessage" | "hydrated"> = {
  captureUrl: "http://localhost:80/@signalk/freeboard-sk/",
  imageTag: "auto",
  width: "1024",
  height: "600",
  fps: "15",
  quality: "6",
  port: "5004",
  touchPort: "5005",
  touch: true,
  healthPort: "5006",
  memoryLimit: "1g",
  restartPolicy: "unless-stopped",
  disableDevShm: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export const useFormStore = create<FormState & FormActions>((set) => ({
  ...DEFAULTS,
  savedMessage: "",
  hydrated: false,

  hydrate(configuration: unknown) {
    const cfg = isRecord(configuration) ? configuration : {};
    const adv = isRecord(cfg.advanced) ? cfg.advanced : {};
    set({
      captureUrl: str(cfg.captureUrl, DEFAULTS.captureUrl),
      imageTag: str(cfg.imageTag, DEFAULTS.imageTag),
      width: str(cfg.width, DEFAULTS.width),
      height: str(cfg.height, DEFAULTS.height),
      fps: str(cfg.fps, DEFAULTS.fps),
      quality: str(cfg.quality, DEFAULTS.quality),
      port: str(cfg.port, DEFAULTS.port),
      touchPort: str(cfg.touchPort, DEFAULTS.touchPort),
      touch: bool(cfg.touch, DEFAULTS.touch),
      healthPort: str(adv.healthPort, DEFAULTS.healthPort),
      memoryLimit: str(adv.memoryLimit, DEFAULTS.memoryLimit),
      restartPolicy: str(adv.restartPolicy, DEFAULTS.restartPolicy),
      disableDevShm: bool(adv.disableDevShm, false),
      savedMessage: "",
      hydrated: true,
    });
  },

  patch(update: Partial<FormState>) {
    set(update);
  },

  markSaved(message: string) {
    set({ savedMessage: message });
  },
}));

/** String → bounded integer with fallback, for the save payload. */
export function toInt(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
