export const LEDGER_ONLY_DETAIL = "from the durable pending-wake ledger";
export type PendingWakeKind = "cloud-agent" | "shell" | "subagent";
export interface PendingWakeMarker {
  agentId: string;
  kind: PendingWakeKind;
  workId: string;
  markedAtMs: number;
  title?: string;
  subagentType?: string;
}
export interface AsyncTask {
  kind: string;
  id: string;
  label: string;
  status: string;
  startedAtMs: number;
  detail?: string;
}
export function markerLabel(marker: PendingWakeMarker): string {
  if (marker.title != null && marker.title.length > 0) return marker.title;
  switch (marker.kind) {
    case "cloud-agent":
      return `Cloud agent ${marker.workId}`;
    case "shell":
      return `Background command ${marker.workId}`;
    case "subagent":
      return `Background task ${marker.workId}`;
  }
}
export function pendingWakeMarkerToAsyncTask(
  marker: PendingWakeMarker,
): AsyncTask {
  return {
    kind: marker.kind,
    id: marker.workId,
    label: markerLabel(marker),
    status: "running",
    startedAtMs: marker.markedAtMs,
    detail:
      marker.subagentType != null && marker.subagentType.length > 0
        ? `${marker.subagentType} · ${LEDGER_ONLY_DETAIL}`
        : LEDGER_ONLY_DETAIL,
  };
}
export function mergeAsyncTasks(
  liveTasks: readonly AsyncTask[],
  markers: readonly PendingWakeMarker[],
): AsyncTask[] {
  const seen = new Set(liveTasks.map((task) => `${task.kind}\0${task.id}`)),
    merged = [...liveTasks];
  for (const marker of markers)
    if (!seen.has(`${marker.kind}\0${marker.workId}`))
      merged.push(pendingWakeMarkerToAsyncTask(marker));
  return merged.sort(
    (a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id),
  );
}
