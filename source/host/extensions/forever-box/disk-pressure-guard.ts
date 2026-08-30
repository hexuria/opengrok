import { stat, statfs } from "node:fs/promises";

export const GIB = 1024 ** 3;
export const DISK_PRESSURE_HEARTBEAT_MS = 5 * 60_000;
export const DISK_PRESSURE_THRESHOLDS = {
  softAvailableBytes: 8 * GIB, softAvailableRatio: 0.15,
  hardAvailableBytes: 2 * GIB, hardAvailableRatio: 0.05,
  softRecoveryBytes: 10 * GIB, softRecoveryRatio: 0.2,
  hardRecoveryBytes: 3 * GIB, hardRecoveryRatio: 0.08,
} as const;

export type DiskPressureLevel = "healthy" | "soft" | "hard";
export interface DiskVolumeSnapshot { readonly volume: string; readonly deviceId: string; readonly totalBytes: number; readonly availableBytes: number }
export interface DiskVolumeSample { readonly snapshots: readonly DiskVolumeSnapshot[]; readonly complete: boolean }
interface DiskPressureState { readonly level: DiskPressureLevel; readonly lastReportedAtMs: number }

export function aggregateDiskPressureLevel(states: ReadonlyMap<string, DiskPressureState>): DiskPressureLevel { const values = [...states.values()]; return values.some((state) => state.level === "hard") ? "hard" : values.some((state) => state.level === "soft") ? "soft" : "healthy"; }
export function classifyDiskPressure(snapshot: Pick<DiskVolumeSnapshot, "totalBytes" | "availableBytes">, previous: DiskPressureLevel = "healthy"): DiskPressureLevel { if (snapshot.totalBytes <= 0) return "healthy"; const ratio = snapshot.availableBytes / snapshot.totalBytes; if (snapshot.availableBytes <= DISK_PRESSURE_THRESHOLDS.hardAvailableBytes || ratio <= DISK_PRESSURE_THRESHOLDS.hardAvailableRatio) return "hard"; if (previous === "hard" && (snapshot.availableBytes <= DISK_PRESSURE_THRESHOLDS.hardRecoveryBytes || ratio <= DISK_PRESSURE_THRESHOLDS.hardRecoveryRatio)) return "hard"; if (snapshot.availableBytes <= DISK_PRESSURE_THRESHOLDS.softAvailableBytes || ratio <= DISK_PRESSURE_THRESHOLDS.softAvailableRatio) return "soft"; if (previous === "soft" && (snapshot.availableBytes <= DISK_PRESSURE_THRESHOLDS.softRecoveryBytes || ratio <= DISK_PRESSURE_THRESHOLDS.softRecoveryRatio)) return "soft"; return "healthy"; }
export async function readDiskVolumeSnapshots(roots: readonly { readonly volume: string; readonly path: string }[]): Promise<DiskVolumeSample> { const snapshots: DiskVolumeSnapshot[] = [], seenDevices = new Set<string>(); let complete = true; for (const root of roots) { try { const [pathStat, fs] = await Promise.all([stat(root.path, { bigint: true }), statfs(root.path, { bigint: true })]); const deviceId = String(pathStat.dev); if (seenDevices.has(deviceId)) continue; seenDevices.add(deviceId); snapshots.push({ volume: root.volume, deviceId, totalBytes: Number(fs.blocks * fs.bsize), availableBytes: Number(fs.bavail * fs.bsize) }); } catch { complete = false; } } return { snapshots, complete }; }

export interface DiskPressureReport extends DiskVolumeSnapshot { readonly level: DiskPressureLevel; readonly trigger: "transition" | "heartbeat"; readonly usedPercent: number }
export interface DiskPressureGuard { onTick(): void; dispose(): void }
export function createDiskPressureGuard(options: { readonly readVolumes: () => Promise<DiskVolumeSample>; readonly report: (report: DiskPressureReport) => void; readonly onPressureChange: (level: "soft" | "hard" | null) => void; readonly onSuccessfulSample?: (level: DiskPressureLevel, complete: boolean) => void; readonly log: (message: string) => void; readonly clock?: { monotonicNow(): number } }): DiskPressureGuard {
  const clock = options.clock ?? { monotonicNow: () => performance.now() }, states = new Map<string, DiskPressureState>(); let aggregate: DiskPressureLevel = "healthy", inFlight = false, disposed = false;
  const check = async (): Promise<void> => { const checkedAtMs = clock.monotonicNow(); let sample: DiskVolumeSample; try { sample = await options.readVolumes(); } catch (error) { options.log(`disk-pressure sample failed: ${String(error)}`); return; } const sampled = new Set<string>(); for (const snapshot of sample.snapshots) { if (disposed) return; sampled.add(snapshot.deviceId); const previous = states.get(snapshot.deviceId), level = classifyDiskPressure(snapshot, previous?.level), transitioned = level !== (previous?.level ?? "healthy"), heartbeatDue = level !== "healthy" && checkedAtMs - (previous?.lastReportedAtMs ?? Number.NEGATIVE_INFINITY) >= DISK_PRESSURE_HEARTBEAT_MS, shouldReport = transitioned || heartbeatDue; states.set(snapshot.deviceId, { level, lastReportedAtMs: shouldReport ? checkedAtMs : previous?.lastReportedAtMs ?? checkedAtMs }); if (shouldReport) try { options.report({ ...snapshot, level, trigger: transitioned ? "transition" : "heartbeat", usedPercent: snapshot.totalBytes > 0 ? (snapshot.totalBytes - snapshot.availableBytes) / snapshot.totalBytes * 100 : 0 }); } catch (error) { options.log(`disk-pressure report delivery failed: ${String(error)}`); } } if (sample.complete) for (const deviceId of states.keys()) if (!sampled.has(deviceId)) states.delete(deviceId); const next = aggregateDiskPressureLevel(states); if (sample.complete || sample.snapshots.length > 0) options.onSuccessfulSample?.(next, sample.complete); if (next !== aggregate) { aggregate = next; options.onPressureChange(next === "healthy" ? null : next); } };
  return { onTick: () => { if (disposed || inFlight) return; inFlight = true; void check().finally(() => { inFlight = false; }); }, dispose: () => { disposed = true; } };
}
