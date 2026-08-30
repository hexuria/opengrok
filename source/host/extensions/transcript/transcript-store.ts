import { overlayTranscriptEntries } from "../../transcript-server/transcript-server-bridge.js";
import type { TranscriptEntry } from "./transcript-hub.js";

let cache: TranscriptEntry[] | undefined;
export function getTranscript(agentId?: string | null): TranscriptEntry[] {
  const local = cache ?? [];
  return agentId == null || agentId.length === 0
    ? local
    : overlayTranscriptEntries(agentId, local) as TranscriptEntry[];
}
export function setTranscript(entries: readonly TranscriptEntry[]): void {
  cache = [...entries];
}
export function appendEntry(entry: TranscriptEntry): void {
  cache = [...(cache ?? []), entry];
}
export function updateEntry(
  id: string,
  update: (entry: TranscriptEntry) => TranscriptEntry,
): TranscriptEntry | null {
  const current = cache ?? [];
  let updated: TranscriptEntry | null = null;
  const next = current.map((entry) => {
    if (entry.id !== id) return entry;
    updated = update(entry);
    return updated;
  });
  if (updated == null) return null;
  cache = next;
  return updated;
}
export function removeEntry(id: string): boolean {
  const current = cache ?? [];
  const next = current.filter((entry) => entry.id !== id);
  if (next.length === current.length) return false;
  cache = next;
  return true;
}
export function clearTranscript(): void {
  cache = [];
}
