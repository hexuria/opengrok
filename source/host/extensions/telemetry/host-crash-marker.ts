import { readFile, rm } from "node:fs/promises";
import { getHostCrashMarkerPath } from "../../host-paths.js";

export const HOST_CRASH_EXIT_SIGNALS = [
  "none",
  "unknown",
  "other",
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGQUIT",
  "SIGSEGV",
  "SIGTERM",
  "SIGTRAP",
  "SIGUSR1",
  "SIGUSR2",
  "SIGXCPU",
  "SIGXFSZ",
] as const;
export type HostCrashMarker = {
  schemaVersion: 1;
  errorClass:
    | "signal_exit"
    | "nonzero_exit"
    | "unexpected_clean_exit"
    | "unobserved_exit";
  exitSignal: string;
  crashedAtMs: number;
  startedAtMs?: number;
  uptimeMs?: number;
};
export type HostCrashMarkerRead =
  | { kind: "present"; raw: string }
  | { kind: "absent" }
  | { kind: "unavailable" };
export interface HostCrashMarkerStore {
  read(): Promise<HostCrashMarkerRead>;
  delete(): Promise<"deleted" | "unavailable">;
}
export function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function isFatalExitSignal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "none" &&
    value !== "unknown" &&
    HOST_CRASH_EXIT_SIGNALS.some((signal) => signal === value)
  );
}
export function readCommonTimes(
  value: Record<string, unknown>,
): { startedAtMs: number; crashedAtMs: number; uptimeMs: number } | null {
  if (
    !("startedAtMs" in value) ||
    !("crashedAtMs" in value) ||
    !("uptimeMs" in value) ||
    !isNonNegativeFinite(value.startedAtMs) ||
    !isNonNegativeFinite(value.crashedAtMs) ||
    !isNonNegativeFinite(value.uptimeMs)
  )
    return null;
  return {
    startedAtMs: value.startedAtMs,
    crashedAtMs: value.crashedAtMs,
    uptimeMs: value.uptimeMs,
  };
}
export function parseJson(
  raw: string,
): { kind: "parsed"; value: unknown } | { kind: "invalid" } {
  try {
    return { kind: "parsed", value: JSON.parse(raw) };
  } catch {
    return { kind: "invalid" };
  }
}
export function parseHostCrashMarker(raw: string): HostCrashMarker | null {
  const parsed = parseJson(raw);
  if (parsed.kind === "invalid") return null;
  const { value } = parsed;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1 || !("errorClass" in v) || !("exitSignal" in v))
    return null;
  if (v.errorClass === "signal_exit" && isFatalExitSignal(v.exitSignal)) {
    const times = readCommonTimes(v);
    return times === null
      ? null
      : {
          schemaVersion: 1,
          errorClass: v.errorClass,
          exitSignal: v.exitSignal,
          ...times,
        };
  }
  if (
    (v.errorClass === "nonzero_exit" ||
      v.errorClass === "unexpected_clean_exit") &&
    v.exitSignal === "none"
  ) {
    const times = readCommonTimes(v);
    return times === null
      ? null
      : {
          schemaVersion: 1,
          errorClass: v.errorClass,
          exitSignal: v.exitSignal,
          ...times,
        };
  }
  if (
    v.errorClass !== "unobserved_exit" ||
    v.exitSignal !== "unknown" ||
    !isNonNegativeFinite(v.crashedAtMs)
  )
    return null;
  const startedAtMs = v.startedAtMs,
    uptimeMs = v.uptimeMs;
  if (
    (startedAtMs !== undefined && !isNonNegativeFinite(startedAtMs)) ||
    (uptimeMs !== undefined && !isNonNegativeFinite(uptimeMs))
  )
    return null;
  return {
    schemaVersion: 1,
    errorClass: v.errorClass,
    exitSignal: v.exitSignal,
    ...(startedAtMs === undefined
      ? {}
      : { startedAtMs: startedAtMs as number }),
    crashedAtMs: v.crashedAtMs,
    ...(uptimeMs === undefined ? {} : { uptimeMs: uptimeMs as number }),
  };
}
export function hostCrashMarkerMetadata(marker: HostCrashMarker) {
  return {
    kind: "process_exit",
    error_class: marker.errorClass,
    exit_signal: marker.exitSignal,
    ...(marker.startedAtMs === undefined
      ? {}
      : { started_at_ms: String(Math.round(marker.startedAtMs)) }),
    crashed_at_ms: String(Math.round(marker.crashedAtMs)),
    ...(marker.uptimeMs === undefined
      ? {}
      : { uptime_ms: String(Math.round(marker.uptimeMs)) }),
  };
}
export function createHostCrashMarkerStore(
  path = getHostCrashMarkerPath(),
): HostCrashMarkerStore {
  return {
    read: async () => {
      try {
        return { kind: "present", raw: await readFile(path, "utf8") };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return { kind: "absent" };
        return { kind: "unavailable" };
      }
    },
    delete: async () => {
      try {
        await rm(path, { force: true });
        return "deleted";
      } catch {
        return "unavailable";
      }
    },
  };
}
export async function deleteIfUnchanged(
  store: HostCrashMarkerStore,
  raw: string,
): Promise<"failed" | "deleted" | "changed"> {
  const current = await store.read();
  if (current.kind === "unavailable") return "failed";
  if (current.kind === "absent") return "deleted";
  if (current.raw !== raw) return "changed";
  return (await store.delete()) === "deleted" ? "deleted" : "failed";
}
export async function forwardHostCrashMarkerWith(forwarder: {
  store: HostCrashMarkerStore;
  wasForwarded(raw: string): boolean;
  markForwarded(raw: string): void;
  emit(marker: HostCrashMarker): Promise<boolean>;
}): Promise<
  | "deferred"
  | "absent"
  | "delete_deferred"
  | "pending"
  | "delivered"
  | "parse_error"
> {
  const read = await forwarder.store.read();
  if (read.kind === "unavailable") return "deferred";
  if (read.kind === "absent") return "absent";
  const { raw } = read;
  if (forwarder.wasForwarded(raw)) {
    const deletion = await deleteIfUnchanged(forwarder.store, raw);
    if (deletion === "failed") return "delete_deferred";
    return deletion === "changed" ? "pending" : "delivered";
  }
  const marker = parseHostCrashMarker(raw);
  if (marker === null) {
    forwarder.markForwarded(raw);
    const deletion = await deleteIfUnchanged(forwarder.store, raw);
    if (deletion === "failed") return "delete_deferred";
    return deletion === "changed" ? "pending" : "parse_error";
  }
  if (!(await forwarder.emit(marker))) return "deferred";
  forwarder.markForwarded(raw);
  const deletion = await deleteIfUnchanged(forwarder.store, raw);
  if (deletion === "failed") return "delete_deferred";
  return deletion === "changed" ? "pending" : "delivered";
}
