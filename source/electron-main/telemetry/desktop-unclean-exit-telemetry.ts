import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { PollingPolicy } from "../../internal/scheduling.js";
import { desktopErrorTags } from "./desktop-error-tags.js";
import type { TelemetryLevel, TelemetryMetadata } from "./desktop-lifecycle-telemetry.js";

export const SESSION_MARKER_FILE_NAME = "sand-session-marker.json";
export const SESSION_MARKER_HEARTBEAT_INTERVAL_MS = 60_000;
export const SESSION_MARKER_ORPHAN_BOUND_MS = 30 * 24 * 60 * 60 * 1_000;
export const VERSION_SHAPE = /^[0-9A-Za-z.+-]{1,64}$/;
const RELAUNCH_GAP_BUCKET_CEILINGS_MS = [60_000, 300_000, 1_800_000, 21_600_000, 86_400_000, SESSION_MARKER_ORPHAN_BOUND_MS] as const;

export interface DesktopSessionMarker { readonly version: 1; readonly pid: number; readonly appVersion: string; readonly startedAtMs: number; readonly aliveAtMs: number; readonly crashSeen: boolean }
export interface UncleanExitSettlement { readonly kind: "marker_orphaned" | "unclean_exit"; readonly prevUptimeBucketMs: number; readonly prevVersion: string; readonly sameVersion: boolean; readonly crashSeqSeen: boolean; readonly prevStartedAtMs: number }

export function relaunchGapBucketMs(gapMs: number): number { for (const ceiling of RELAUNCH_GAP_BUCKET_CEILINGS_MS) if (gapMs < ceiling) return ceiling; return SESSION_MARKER_ORPHAN_BOUND_MS; }
export function parseDesktopSessionMarker(value: unknown): DesktopSessionMarker | null {
  if (typeof value !== "object" || value === null) return null;
  const marker = value as Record<string, unknown>;
  if (marker.version !== 1 || typeof marker.pid !== "number" || !Number.isInteger(marker.pid) || marker.pid < 0 || typeof marker.appVersion !== "string" || !VERSION_SHAPE.test(marker.appVersion) || typeof marker.startedAtMs !== "number" || !Number.isFinite(marker.startedAtMs) || typeof marker.aliveAtMs !== "number" || !Number.isFinite(marker.aliveAtMs) || typeof marker.crashSeen !== "boolean") return null;
  return marker as unknown as DesktopSessionMarker;
}
export function decideUncleanExitSettlement(marker: DesktopSessionMarker, args: { readonly markerPidAlive: boolean; readonly nowMs: number; readonly currentVersion: string }): UncleanExitSettlement | null {
  if (args.markerPidAlive) return null;
  const aliveAtMs = Math.max(marker.startedAtMs, marker.aliveAtMs);
  const ageMs = Math.max(0, args.nowMs - aliveAtMs);
  return { kind: ageMs > SESSION_MARKER_ORPHAN_BOUND_MS ? "marker_orphaned" : "unclean_exit", prevUptimeBucketMs: relaunchGapBucketMs(Math.max(0, aliveAtMs - marker.startedAtMs)), prevVersion: marker.appVersion, sameVersion: marker.appVersion === args.currentVersion, crashSeqSeen: marker.crashSeen, prevStartedAtMs: marker.startedAtMs };
}
export function uncleanExitReport(settlement: UncleanExitSettlement): { level: TelemetryLevel; metadata: TelemetryMetadata } {
  const metadata = { kind: settlement.kind, prev_uptime_ms: String(settlement.prevUptimeBucketMs), prev_version: settlement.prevVersion, same_version: String(settlement.sameVersion), crash_seq_seen: String(settlement.crashSeqSeen), prev_started_at_ms: String(settlement.prevStartedAtMs) };
  return settlement.kind === "marker_orphaned" ? { level: "info", metadata } : { level: "warn", metadata: { ...metadata, ...desktopErrorTags("SAND-E0610") } };
}
export function settleUncleanExitOnSessionEnd(window: { on(event: "session-end", listener: () => void): void }, controller: { settleClean(): void }): void { window.on("session-end", () => controller.settleClean()); }

export function createDesktopUncleanExitSettlement(deps: {
  readonly markerPath: string;
  readonly report: (level: TelemetryLevel, metadata: TelemetryMetadata) => void;
  readonly pid: number;
  readonly isPidAlive: (pid: number) => boolean;
  readonly startedAtMs: number;
  readonly heartbeatPolicy: PollingPolicy;
  readonly nowMs?: () => number;
  readonly reportEdgeFailure?: (subsystem: string, leg: string, error: unknown) => void;
}) {
  const nowMs = deps.nowMs ?? Date.now;
  let armed: DesktopSessionMarker | undefined;
  let state: "idle" | "armed" | "settled" = "idle";
  let crashSeenBeforeArm = false;
  let heartbeatHandle: { dispose(): void } | undefined;
  const edge = (leg: string, error: unknown) => { try { deps.reportEdgeFailure?.("session-marker", leg, error); } catch {} };
  const remove = () => { try { rmSync(deps.markerPath, { force: true }); } catch (error) { edge("marker-clear", error); } };
  const loadPrior = (): DesktopSessionMarker | null => {
    let raw: string;
    try { raw = readFileSync(deps.markerPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") edge("marker-read", error); return null; }
    try { const marker = parseDesktopSessionMarker(JSON.parse(raw)); if (marker == null) throw new Error("Invalid desktop session marker"); return marker; }
    catch (error) { edge("marker-read", error); remove(); return null; }
  };
  const write = (marker: DesktopSessionMarker) => {
    armed = marker;
    try { writeFileSync(`${deps.markerPath}.tmp`, JSON.stringify(marker), "utf8"); renameSync(`${deps.markerPath}.tmp`, deps.markerPath); }
    catch (error) { edge("marker-write", error); }
  };
  const heartbeat = () => { if (state === "armed" && armed != null) write({ ...armed, aliveAtMs: nowMs() }); };
  return {
    settlePriorSessionAndArm(currentVersion: string): boolean {
      if (state !== "idle") return false;
      state = "armed";
      const prior = loadPrior();
      let emitted = false;
      if (prior != null) {
        const settlement = decideUncleanExitSettlement(prior, { currentVersion, nowMs: nowMs(), markerPidAlive: prior.pid !== deps.pid && deps.isPidAlive(prior.pid) });
        if (settlement != null) { const report = uncleanExitReport(settlement); deps.report(report.level, report.metadata); emitted = true; }
      }
      write({ version: 1, pid: deps.pid, appVersion: VERSION_SHAPE.test(currentVersion) ? currentVersion : "unknown", startedAtMs: deps.startedAtMs, aliveAtMs: nowMs(), crashSeen: crashSeenBeforeArm });
      heartbeatHandle = deps.heartbeatPolicy.start(async () => { heartbeat(); });
      return emitted;
    },
    heartbeat,
    noteCrashSeen(): void { crashSeenBeforeArm = true; if (state !== "armed" || armed == null || armed.crashSeen) return; write({ ...armed, aliveAtMs: nowMs(), crashSeen: true }); },
    settleClean(): void { if (state !== "armed") return; state = "settled"; armed = undefined; heartbeatHandle?.dispose(); heartbeatHandle = undefined; remove(); },
  };
}
