import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const UPDATE_VERSION_SHAPE = /^[0-9A-Za-z.+-]{1,64}$/;
export const RELAUNCH_CONFIRM_WINDOW_MS = 5 * 60_000;
export const UPDATE_MARKER_ORPHAN_BOUND_MS = 30 * 24 * 60 * 60_000;
const ERRNO_SHAPE = /^[0-9A-Za-z._|:-]{1,64}$/;
const BUCKETS = [60_000, 300_000, 1_800_000, 21_600_000, 86_400_000, UPDATE_MARKER_ORPHAN_BOUND_MS] as const;
export type UpdateApplyPhase = "staged" | "requested" | "spawned" | "spawn_failed";
export type UpdateMechanism = "squirrel" | "nsis";
export interface UpdateApplyMarker { readonly version: 1; readonly phase: UpdateApplyPhase; readonly mechanism: UpdateMechanism; readonly targetVersion: string; readonly fromVersion: string; readonly stagedAtMs: number; readonly requestedAtMs?: number; readonly spawnErrno?: string }

export function parseUpdateApplyMarker(value: unknown): UpdateApplyMarker | null { if (typeof value !== "object" || value === null) return null; const m = value as Record<string, unknown>; if (m.version !== 1 || !["staged", "requested", "spawned", "spawn_failed"].includes(m.phase as string) || !["squirrel", "nsis"].includes(m.mechanism as string) || typeof m.targetVersion !== "string" || !UPDATE_VERSION_SHAPE.test(m.targetVersion) || typeof m.fromVersion !== "string" || !UPDATE_VERSION_SHAPE.test(m.fromVersion) || typeof m.stagedAtMs !== "number" || !Number.isFinite(m.stagedAtMs) || m.requestedAtMs !== undefined && (typeof m.requestedAtMs !== "number" || !Number.isFinite(m.requestedAtMs)) || m.spawnErrno !== undefined && (typeof m.spawnErrno !== "string" || !ERRNO_SHAPE.test(m.spawnErrno))) return null; return m as unknown as UpdateApplyMarker; }
export function updateRelaunchGapBucketMs(gapMs: number): number { for (const ceiling of BUCKETS) if (gapMs < ceiling) return ceiling; return UPDATE_MARKER_ORPHAN_BOUND_MS; }
const updateError = (code: string, payload: Record<string, string> = {}) => ({ code, ...payload });

export function createUpdateApplyMarkerStore(markerPath: string, nowMs: () => number = Date.now, reportFailure: (leg: string, error: unknown) => void = () => {}) {
  let current: UpdateApplyMarker | null | undefined;
  const remove = () => { try { rmSync(markerPath, { force: true }); } catch (error) { reportFailure("marker-clear", error); } };
  const load = () => { let raw: string; try { raw = readFileSync(markerPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") reportFailure("marker-read", error); return null; } try { const parsed = parseUpdateApplyMarker(JSON.parse(raw)); if (parsed == null) throw new Error("Invalid update apply marker"); return parsed; } catch (error) { reportFailure("marker-read", error); remove(); return null; } };
  const write = (marker: UpdateApplyMarker) => { current = marker; try { writeFileSync(`${markerPath}.tmp`, JSON.stringify(marker), "utf8"); renameSync(`${markerPath}.tmp`, markerPath); } catch (error) { reportFailure("marker-write", error); } };
  const peek = () => { if (current === undefined) current = load(); return current; };
  return { peek, recordStaged(input: { mechanism: UpdateMechanism; targetVersion: string; fromVersion: string }) { write({ version: 1, phase: "staged", ...input, stagedAtMs: nowMs() }); }, recordRequested(input: { mechanism: UpdateMechanism; targetVersion: string; fromVersion: string }) { const staged = peek(); write({ version: 1, phase: "requested", ...input, stagedAtMs: staged != null && staged.targetVersion === input.targetVersion ? staged.stagedAtMs : nowMs(), requestedAtMs: nowMs() }); }, recordSpawned() { const marker = peek(); if (marker != null) write({ ...marker, phase: "spawned" }); }, recordSpawnFailed(error: unknown) { const marker = peek(); if (marker == null) return; const code = error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code! : "E_OTHER"; write({ ...marker, phase: "spawn_failed", spawnErrno: ERRNO_SHAPE.test(code) ? code : "E_OTHER" }); }, clear() { current = null; remove(); } };
}

export function decideUpdateApplySettlement(marker: UpdateApplyMarker, runningVersion: string, nowMs: number): any[] {
  const leg = { mechanism: marker.mechanism, targetVersion: marker.targetVersion, fromVersion: marker.fromVersion };
  const ageMs = Math.max(0, nowMs - (marker.requestedAtMs ?? marker.stagedAtMs));
  const terminal = { ...leg, phase: marker.phase, durationMs: ageMs };
  if (ageMs > UPDATE_MARKER_ORPHAN_BOUND_MS || runningVersion !== marker.fromVersion && runningVersion !== marker.targetVersion) return [{ outcome: "marker_orphaned", ...terminal }];
  const spawned = marker.phase === "spawned" ? [{ outcome: "spawned", ...leg }] : [];
  if (runningVersion === marker.targetVersion) { if (marker.phase === "staged") return [{ outcome: "confirmed", ...terminal }]; const bucket = updateRelaunchGapBucketMs(ageMs); return ageMs <= RELAUNCH_CONFIRM_WINDOW_MS ? [...spawned, { outcome: "confirmed", ...terminal, relaunchGapBucketMs: bucket }] : [...spawned, { outcome: "confirmed_late", ...terminal, relaunchGapBucketMs: bucket, error: updateError("SAND-E0512") }]; }
  if (marker.phase === "staged") return marker.mechanism === "squirrel" ? [{ outcome: "stale_version", ...terminal, error: updateError("SAND-E0509") }] : [];
  if (marker.phase === "spawn_failed") return [{ outcome: "stale_version", ...terminal, error: updateError("SAND-E0511", { errno: marker.spawnErrno ?? "E_OTHER" }) }];
  return [...spawned, { outcome: "stale_version", ...terminal, error: updateError("SAND-E0510") }];
}
