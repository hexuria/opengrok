export const REQUEST_SOURCES = new Set(["turn", "automation", "notification", "connector", "event", "handoff-resume", "background-revival", "web-search", "web-fetch"] as const);
export const EMPTY_SAND_PROFILE = { description: "", avatarPath: null } as const;
export const EMPTY_UNREAD_STATE = { lastActivityAt: 0, lastViewedAt: 0, isManuallyUnread: false, unreadCount: 0 } as const;
export const EMPTY_SPEND_GUARD_STATE = { nudgedAtMs: null, snoozedUntilMs: null, optedOut: false, cardEntryIds: [], pausedAutomationIds: [] } as const;
export const REQUEST_ID_HISTORY_MAX = 200;
export const REQUEST_ID_PROMPT_MAX = 200;
export const EPISODE_TURN_TEXT_CAP = 2_000;
export const EPISODE_PENDING_MAX = 64;

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | null { return value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }
function parse(raw: string | null): unknown { if (raw == null) return null; try { return JSON.parse(raw) as unknown; } catch { return null; } }

export function isValidTranscriptEntry(entry: unknown): entry is JsonObject {
  const value = object(entry); if (value == null) return false;
  switch (value.kind) {
    case "send-message": { const message = object(value.message); return message != null && (message.type !== "text" || typeof message.content === "string"); }
    case "message": return typeof value.content === "string";
    case "user-attachment": return typeof value.file_path === "string";
    case "tool-call": return typeof value.name === "string";
    case "notice": return typeof value.text === "string";
    case "event": return typeof object(value.event)?.type === "string";
    // A kind this build does not know is still a transcript entry. The store
    // wire, the coordinator RPC and the renderer feed all pass it through
    // untouched; dropping it here would be the only lossy hop, and would erase
    // entries written by a newer build on the same device.
    default: return typeof value.kind === "string" && value.kind.length > 0 && typeof value.id === "string" && value.id.length > 0;
  }
}
export function parseTranscriptEntry(raw: string): JsonObject | null { const entry = parse(raw); return object(entry)?.kind !== "error" && isValidTranscriptEntry(entry) ? entry : null; }
export function parseProfile(raw: string | null): { description: string; avatarPath: string | null } {
  const value = object(parse(raw)); if (value == null) return { ...EMPTY_SAND_PROFILE };
  return { description: typeof value.description === "string" ? value.description : "", avatarPath: typeof value.avatarPath === "string" && value.avatarPath.length > 0 ? value.avatarPath : null };
}
export function parseUnreadState(raw: string | null): { lastActivityAt: number; lastViewedAt: number; isManuallyUnread: boolean; unreadCount: number } {
  const value = object(parse(raw)); if (value == null) return { ...EMPTY_UNREAD_STATE };
  const finite = (candidate: unknown): number => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
  const unread = finite(value.unreadCount);
  return { lastActivityAt: finite(value.lastActivityAt), lastViewedAt: finite(value.lastViewedAt), isManuallyUnread: value.isManuallyUnread === true, unreadCount: unread > 0 ? Math.floor(unread) : 0 };
}
export interface SpendGuardState { nudgedAtMs: number | null; snoozedUntilMs: number | null; optedOut: boolean; cardEntryIds: string[]; pausedAutomationIds: string[] }
export function resolveSpendGuardState(raw: { state: string | null; legacyNudgedAt?: unknown }): SpendGuardState {
  if (raw.state == null) { const legacy = Number(raw.legacyNudgedAt); return Number.isFinite(legacy) && legacy > 0 ? { ...EMPTY_SPEND_GUARD_STATE, cardEntryIds: [], pausedAutomationIds: [], nudgedAtMs: legacy } : { ...EMPTY_SPEND_GUARD_STATE, cardEntryIds: [], pausedAutomationIds: [] }; }
  const value = object(parse(raw.state)); if (value == null) return { ...EMPTY_SPEND_GUARD_STATE, cardEntryIds: [], pausedAutomationIds: [] };
  const positive = (candidate: unknown): number | null => typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? candidate : null;
  const ids = (candidate: unknown): string[] => Array.isArray(candidate) ? candidate.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  return { nudgedAtMs: positive(value.nudgedAtMs), snoozedUntilMs: positive(value.snoozedUntilMs), optedOut: value.optedOut === true, cardEntryIds: ids(value.cardEntryIds), pausedAutomationIds: ids(value.pausedAutomationIds) };
}
export function serializeSpendGuardState(state: SpendGuardState): string | null { return state.nudgedAtMs == null && state.snoozedUntilMs == null && !state.optedOut && state.cardEntryIds.length === 0 && state.pausedAutomationIds.length === 0 ? null : JSON.stringify(state); }
export function parseAwaitingState(raw: string | null): { tabId: string; reason: string; since: number } | null {
  const value = object(parse(raw)); if (value == null) return null; const tabId = typeof value.tabId === "string" ? value.tabId : ""; if (!tabId) return null;
  return { tabId, reason: typeof value.reason === "string" ? value.reason : "", since: typeof value.since === "number" && Number.isFinite(value.since) ? value.since : 0 };
}
export interface RequestRecord { id: string; at: number; prompt?: string; source?: string }
export function parseRequestRecords(raw: string | null): RequestRecord[] {
  const value = parse(raw); if (!Array.isArray(value)) return []; const records: RequestRecord[] = [];
  for (const item of value) { const entry = object(item); if (entry == null) continue; const id = typeof entry.id === "string" ? entry.id.trim() : ""; if (!id) continue; const at = typeof entry.at === "number" && Number.isFinite(entry.at) && entry.at > 0 ? entry.at : 0; const prompt = typeof entry.prompt === "string" && entry.prompt.length > 0 ? entry.prompt : undefined; const source = typeof entry.source === "string" && REQUEST_SOURCES.has(entry.source as never) ? entry.source : undefined; records.push({ id, at, ...(prompt == null ? {} : { prompt }), ...(source == null ? {} : { source }) }); }
  return records;
}
export function parseMemoryPromptSnapshot(raw: string | null): { render: string; compactionEpoch: number } | null { const value = object(parse(raw)); return value != null && typeof value.render === "string" && typeof value.compactionEpoch === "number" && Number.isFinite(value.compactionEpoch) ? { render: value.render, compactionEpoch: value.compactionEpoch } : null; }
export function parsePendingEpisodeTurns(raw: string | null): Array<{ ts: number; user: string; agent: string }> { const value = parse(raw); if (!Array.isArray(value)) return []; const turns: Array<{ ts: number; user: string; agent: string }> = []; for (const item of value) { const entry = object(item); if (entry == null) continue; const user = typeof entry.user === "string" ? entry.user : "", agent = typeof entry.agent === "string" ? entry.agent : ""; if (!user && !agent) continue; turns.push({ ts: typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : 0, user, agent }); } return turns; }
