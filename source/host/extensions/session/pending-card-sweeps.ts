import { settlePendingAutoReviewApprovalEntry, settlePendingLocalToolPermissionEntry } from "../../../shared/transcript.js";

interface TranscriptDb { getTranscriptEntries(): Array<Record<string, unknown>>; updateTranscriptEntry(id: string, update: (entry: Record<string, unknown>) => Record<string, unknown>): void }
type Entry = Record<string, unknown> & { id: string; kind: string; timestampMs?: number; message?: { type?: string; approval?: { requestId: string; status: string }; ask?: { requestId: string; status: string } } };

export function expirePendingAutoReviewApprovalEntries(db: TranscriptDb, onlyRequestId?: string): string[] {
  const expired: string[] = [];
  for (const raw of db.getTranscriptEntries()) { const entry = raw as Entry; if (entry.kind !== "send-message" || entry.message?.type !== "auto-review-approval" || entry.message.approval?.status !== "pending") continue; const requestId = entry.message.approval.requestId; const settled = settlePendingAutoReviewApprovalEntry(entry, "expired", onlyRequestId ?? requestId); if (settled == null) continue; db.updateTranscriptEntry(entry.id, () => settled); expired.push(requestId); }
  return expired;
}
export function expirePendingLocalToolPermissionAskEntries(db: TranscriptDb, options?: { onlyRequestId?: string; ifPendingBeforeMs?: number }): string[] {
  const expired: string[] = [];
  for (const raw of db.getTranscriptEntries()) { const entry = raw as Entry; if (entry.kind !== "send-message" || entry.message?.type !== "local-tool-permission" || entry.message.ask?.status !== "pending") continue; if (options?.ifPendingBeforeMs != null && entry.timestampMs != null && entry.timestampMs >= options.ifPendingBeforeMs) continue; const requestId = entry.message.ask.requestId; const settled = settlePendingLocalToolPermissionEntry(entry, "expired", options?.onlyRequestId ?? requestId); if (settled == null) continue; db.updateTranscriptEntry(entry.id, () => settled); expired.push(requestId); }
  return expired;
}
