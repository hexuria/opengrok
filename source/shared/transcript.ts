export const SAND_AUTO_REVIEW_STALE = "auto-review/stale";
export const SAND_AUTO_REVIEW_STALE_MESSAGE = "The Auto-review request is stale, expired, or not authorized.";

interface ApprovalEntry { readonly kind: string; readonly message?: { readonly type?: string; readonly approval?: { readonly requestId: string; readonly status: string; readonly [key: string]: unknown }; readonly ask?: { readonly requestId: string; readonly status: string; readonly [key: string]: unknown }; readonly [key: string]: unknown }; readonly id?: string; readonly replyTo?: string; readonly branched?: boolean; readonly fromAgent?: unknown; readonly toAgent?: { readonly kind?: string }; readonly [key: string]: unknown }

export function settlePendingAutoReviewApprovalEntry<T extends ApprovalEntry>(entry: T, status: string, requestId?: string): T | null {
  const approval = entry.message?.approval;
  if (entry.kind !== "send-message" || entry.message?.type !== "auto-review-approval" || approval?.status !== "pending" || (requestId != null && approval.requestId !== requestId)) return null;
  return { ...entry, message: { ...entry.message, approval: { ...approval, status } } } as T;
}

export function settlePendingLocalToolPermissionEntry<T extends ApprovalEntry>(entry: T, status: string, requestId?: string): T | null {
  const ask = entry.message?.ask;
  if (entry.kind !== "send-message" || entry.message?.type !== "local-tool-permission" || ask?.status !== "pending" || (requestId != null && ask.requestId !== requestId)) return null;
  return { ...entry, message: { ...entry.message, ask: { ...ask, status } } } as T;
}

export const SAND_REACTION_SELF = "me";
export const SAND_REACTION_AGENT = "agent";

function getEntryReplyTo(entry: ApprovalEntry): string | undefined { return ["message", "send-message", "user-attachment", "notice"].includes(entry.kind) ? entry.replyTo : undefined; }
function isBranchedEntry(entry: ApprovalEntry): boolean { return ["message", "send-message", "user-attachment", "notice"].includes(entry.kind) && entry.branched === true; }
function resolveBranchRoot(entry: ApprovalEntry, byId: ReadonlyMap<string, ApprovalEntry>): string | null { let current = entry; const seen = new Set([entry.id]); for (;;) { const parentId = getEntryReplyTo(current); if (parentId == null) return null; const parent = byId.get(parentId); if (parent == null) return null; if (!isBranchedEntry(parent)) return parentId; if (seen.has(parentId)) return null; seen.add(parentId); current = parent; } }

export function getMainTranscriptEntries<T extends ApprovalEntry>(entries: readonly T[]): readonly T[] {
  const byId = new Map(entries.flatMap((entry) => entry.id === undefined ? [] : [[entry.id, entry] as const]));
  const isThreadMessage = (entry: T) => isBranchedEntry(entry) && resolveBranchRoot(entry, byId) != null;
  return entries.some(isThreadMessage) ? entries.filter((entry) => !isThreadMessage(entry)) : entries;
}

export function getThreadTranscriptEntries<T extends ApprovalEntry>(entries: readonly T[], rootId: string): readonly T[] {
  const byId = new Map(entries.flatMap((entry) => entry.id === undefined ? [] : [[entry.id, entry] as const])); if (!byId.has(rootId)) return [];
  const children = new Map<string, string[]>(); for (const candidate of entries) { const parentId = getEntryReplyTo(candidate); if (parentId == null || candidate.id == null) continue; const bucket = children.get(parentId); if (bucket == null) children.set(parentId, [candidate.id]); else bucket.push(candidate.id); }
  const thread = new Set([rootId]); const queue = [rootId]; while (queue.length > 0) { const nextId = queue.shift(); if (nextId == null) continue; for (const childId of children.get(nextId) ?? []) { if (thread.has(childId)) continue; const child = byId.get(childId); if (child == null || !isBranchedEntry(child)) continue; thread.add(childId); queue.push(childId); } }
  return entries.filter((candidate) => candidate.id !== undefined && thread.has(candidate.id));
}

export function isAgentPeerMessageEntry(entry: ApprovalEntry | null | undefined): boolean { return entry != null && entry.kind === "message" && (entry.fromAgent != null || entry.toAgent != null); }
export function isOutboundAgentPeerMessageEntry(entry: ApprovalEntry | null | undefined): boolean { return entry != null && entry.kind === "message" && entry.toAgent != null; }
export function isHiddenOutboundAgentPeerMessageEntry(entry: ApprovalEntry | null | undefined): boolean { return isOutboundAgentPeerMessageEntry(entry) && entry?.toAgent?.kind !== "agent"; }
export function entryRaisesUserActivitySignal(entry: ApprovalEntry): boolean { return !isAgentPeerMessageEntry(entry); }
