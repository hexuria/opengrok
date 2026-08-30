const MAX_SHELL_SNAPSHOT_CHARS = 20_000;
const MAX_SHELL_SNAPSHOT_COUNT = 100;
const shellOutputSnapshots = new Map<string, string>();
function ensureSnapshotCapacity(toolCallId: string): void {
  if (shellOutputSnapshots.has(toolCallId) || shellOutputSnapshots.size < MAX_SHELL_SNAPSHOT_COUNT) return;
  const oldestKey = shellOutputSnapshots.keys().next().value;
  if (oldestKey !== undefined) shellOutputSnapshots.delete(oldestKey);
}
export function startInterruptedShellOutputSnapshot(toolCallId: string): void { ensureSnapshotCapacity(toolCallId); shellOutputSnapshots.set(toolCallId, ""); }
export function appendInterruptedShellOutputSnapshot(toolCallId: string, output: string): void {
  if (output.length === 0) return;
  const existing = shellOutputSnapshots.get(toolCallId);
  if (existing === undefined) { ensureSnapshotCapacity(toolCallId); shellOutputSnapshots.set(toolCallId, output.slice(-MAX_SHELL_SNAPSHOT_CHARS)); return; }
  shellOutputSnapshots.set(toolCallId, `${existing}${output}`.slice(-MAX_SHELL_SNAPSHOT_CHARS));
}
export function getInterruptedShellOutputSnapshot(toolCallId: string): string | undefined { return shellOutputSnapshots.get(toolCallId); }
export function clearInterruptedShellOutputSnapshot(toolCallId: string): void { shellOutputSnapshots.delete(toolCallId); }
