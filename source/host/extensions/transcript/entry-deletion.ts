import { threadDescendants } from "../../../shared/transcript-threads.js";
import { getTranscript, removeEntry } from "./transcript-store.js";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.js";

type LiveSession = any;

export type EntryDeletionBlockReason =
  | "branch-root-with-children"
  | "not-found"
  | "pending";

export interface EntryDeletionBlock {
  id: string;
  reason: EntryDeletionBlockReason;
}
export interface DeleteTranscriptEntriesResult {
  deleted: string[];
  blocked: EntryDeletionBlock[];
}

export function isPendingTranscriptEntry(entry: TranscriptEntry): boolean {
  if (entry.isStreaming === true || entry.streaming === true) return true;
  const message = entry.message as
    | {
        approval?: { status?: string };
        ask?: { status?: string };
      }
    | undefined;
  return (
    message?.approval?.status === "pending" || message?.ask?.status === "pending"
  );
}

/** Pure per-entry policy shared by the deletion domain and its tests. */
export function classifyEntryDeletion(
  entryId: string,
  entries: readonly TranscriptEntry[],
): { index: number; reason: EntryDeletionBlockReason | null } {
  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) return { index, reason: "not-found" };
  if (isPendingTranscriptEntry(entries[index]!))
    return { index, reason: "pending" };
  const branched = entries.filter((entry) => entry.branched === true);
  return threadDescendants(entryId, branched).length > 0
    ? { index, reason: "branch-root-with-children" }
    : { index, reason: null };
}

export class TranscriptEntryDeletion {
  constructor(readonly tm: TranscriptManagerLike) {}

  async deleteTranscriptEntries(args: {
    agentId: string;
    entryIds: readonly string[];
  }): Promise<DeleteTranscriptEntriesResult> {
    const result: DeleteTranscriptEntriesResult = { deleted: [], blocked: [] };
    const entryIds = args.entryIds ?? [];
    if (entryIds.length === 0) return result;
    await this.tm.sessions.ensureActionTarget(args.agentId);
    const session = this.liveSessionFor(args.agentId);
    if (session == null) {
      for (const id of entryIds)
        result.blocked.push({ id, reason: "not-found" });
      return result;
    }
    const isOnScreen =
      this.tm.sessions.activeSession?.id === session.id &&
      this.tm.sessions.inMemoryTranscriptAgentId === session.id;
    const entries = [
      ...(isOnScreen
        ? getTranscript()
        : (session.db.getTranscriptEntries() as TranscriptEntry[])),
    ];
    for (const entryId of entryIds) {
      const decision = classifyEntryDeletion(entryId, entries);
      if (decision.reason != null) {
        result.blocked.push({ id: entryId, reason: decision.reason });
        continue;
      }
      entries.splice(decision.index, 1);
      if (isOnScreen) removeEntry(entryId);
      session.db.deleteTranscriptEntry(entryId);
      session.db.addRetiredEntryIds([entryId]);
      this.tm.roster.emit({ type: "removed", id: entryId }, args.agentId);
      result.deleted.push(entryId);
    }
    return result;
  }

  private liveSessionFor(agentId: string): LiveSession | null {
    return this.tm.sessions.activeSession?.id === agentId
      ? this.tm.sessions.activeSession
      : (this.tm.sessions.liveSessions.get(agentId) ?? null);
  }
}
