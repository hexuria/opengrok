import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
export class SandProfilerCaptureError extends Error {}
export const DEFAULT_PROFILE_DURATION_MS = 15_000,
  DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60_000,
  DEFAULT_MAX_RETAINED_PROFILES = 3,
  DEFAULT_SUSTAINED_PRESSURE_WINDOW_MS = 150_000,
  PROFILER_SAMPLING_INTERVAL_US = 10_000,
  PRESSURE_CPU_PROFILE_PREFIX = "sand-host-pressure-",
  PRESSURE_CPU_PROFILE_DIR = "/tmp/sand-host-profiles";
export interface CpuProfilerBackend {
  start(): Promise<void>;
  stop(): Promise<string>;
  dispose(): void;
}
export function createInspectorBackend(): CpuProfilerBackend {
  let session: Session | undefined;
  return {
    start: async () => {
      const starting = new Session();
      starting.connect();
      try {
        await starting.post("Profiler.enable");
        await starting.post("Profiler.setSamplingInterval", {
          interval: PROFILER_SAMPLING_INTERVAL_US,
        });
        await starting.post("Profiler.start");
      } catch (error) {
        try {
          starting.disconnect();
        } catch {}
        throw error;
      }
      session = starting;
    },
    stop: async () => {
      const active = session;
      if (active == null) throw new Error("profiler session not started");
      try {
        const { profile } = await active.post("Profiler.stop");
        if (profile == null)
          throw new SandProfilerCaptureError("profiler returned no profile");
        return JSON.stringify(profile);
      } finally {
        active.disconnect();
        session = undefined;
      }
    },
    dispose: () => {
      session?.disconnect();
      session = undefined;
    },
  };
}
export interface PressureCpuProfilerKnobs {
  sustainedPressureWindowMs?: number;
  profileDurationMs?: number;
  minIntervalMs?: number;
  maxRetainedProfiles?: number;
}
export function createPressureCpuProfiler(
  options: PressureCpuProfilerKnobs & {
    directory?: string;
    backend?: CpuProfilerBackend;
    now?: () => number;
    overrides?: () => PressureCpuProfilerKnobs | undefined;
    onCaptured?: (path: string) => void;
  },
) {
  const directory = options.directory ?? PRESSURE_CPU_PROFILE_DIR,
    backend = options.backend ?? createInspectorBackend(),
    now = options.now ?? Date.now;
  const knobs = () => {
    let live: PressureCpuProfilerKnobs | undefined;
    try {
      live = options.overrides?.();
    } catch {
      live = undefined;
    }
    return {
      sustainedPressureWindowMs:
        live?.sustainedPressureWindowMs ??
        options.sustainedPressureWindowMs ??
        DEFAULT_SUSTAINED_PRESSURE_WINDOW_MS,
      profileDurationMs:
        live?.profileDurationMs ??
        options.profileDurationMs ??
        DEFAULT_PROFILE_DURATION_MS,
      minIntervalMs:
        live?.minIntervalMs ?? options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      maxRetainedProfiles: Math.max(
        1,
        live?.maxRetainedProfiles ??
          options.maxRetainedProfiles ??
          DEFAULT_MAX_RETAINED_PROFILES,
      ),
    };
  };
  let state: "idle" | "starting" | "profiling" | "stopping" = "idle",
    captureDeadlineMs = 0,
    lastCaptureStartedAtMs: number | undefined,
    previousPressureAtMs: number | undefined,
    disposed = false;
  const pruneOldProfiles = (max: number) => {
    const profiles = readdirSync(directory)
      .filter((name) => name.startsWith(PRESSURE_CPU_PROFILE_PREFIX))
      .sort();
    for (const name of profiles.slice(0, Math.max(0, profiles.length - max)))
      rmSync(join(directory, name), { force: true });
  };
  const finishCapture = async () => {
    state = "stopping";
    try {
      const profileJson = await backend.stop();
      if (disposed) return;
      mkdirSync(directory, { recursive: true });
      const path = join(
        directory,
        `${PRESSURE_CPU_PROFILE_PREFIX}${now()}.cpuprofile`,
      );
      writeFileSync(path, profileJson);
      pruneOldProfiles(knobs().maxRetainedProfiles);
      console.warn(`[sand-host] pressure CPU profile written: ${path}`);
      options.onCaptured?.(path);
    } catch (error) {
      console.warn("[sand-host] pressure CPU profile capture failed:", error);
    } finally {
      state = "idle";
    }
  };
  return {
    onPressure: () => {
      if (disposed || state !== "idle") return;
      const nowMs = now(),
        effective = knobs();
      if (
        lastCaptureStartedAtMs != null &&
        nowMs - lastCaptureStartedAtMs < effective.minIntervalMs
      )
        return;
      const sustained =
        previousPressureAtMs != null &&
        nowMs - previousPressureAtMs <= effective.sustainedPressureWindowMs;
      if (!sustained) {
        previousPressureAtMs = nowMs;
        return;
      }
      previousPressureAtMs = undefined;
      state = "starting";
      lastCaptureStartedAtMs = nowMs;
      void backend
        .start()
        .then(() => {
          if (disposed) {
            backend.dispose();
            state = "idle";
            return;
          }
          if (state === "starting") {
            captureDeadlineMs = now() + effective.profileDurationMs;
            state = "profiling";
          }
        })
        .catch((error) => {
          console.warn("[sand-host] pressure CPU profile start failed:", error);
          state = "idle";
          lastCaptureStartedAtMs = undefined;
        });
    },
    onTick: () => {
      if (disposed || state !== "profiling" || now() < captureDeadlineMs)
        return;
      void finishCapture();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (state === "starting" || state === "profiling") backend.dispose();
      state = "idle";
    },
  };
}
