/**
 * Deleting a message: which routes can, and what the server calls the ids.
 *
 * The page has no delete of its own. Three of the four routes keep a transcript we can reach:
 * the OpenGrok server (`deleteTranscriptEntries {agentId, ids}`, which answers `{deleted: n}` and
 * emits a `removed` frame per entry) and the local router for Claude, Codex and OpenRouter
 * (`{agentId, entryIds}`, answering `{deleted: [...], blocked: [...]}`). Cursor keeps its
 * transcripts where nothing here can reach them, so the menu item does not exist there.
 */

export type TranscriptDeletionRoute = "opengrok" | "local" | "cursor";

export interface TranscriptDeletion {
  readonly available: boolean;
  readonly route: TranscriptDeletionRoute;
  /** Why not, in words for the page; null when available. */
  readonly reason: string | null;
}

const LOCAL_PROVIDERS = new Set(["claude-code", "codex", "openrouter"]);

export function transcriptDeletionFor(boxRuntime: unknown, provider: unknown): TranscriptDeletion {
  if (boxRuntime === "opengrok") return { available: true, route: "opengrok", reason: null };
  if (typeof provider === "string" && LOCAL_PROVIDERS.has(provider)) return { available: true, route: "local", reason: null };
  return { available: false, route: "cursor", reason: "Cursor keeps its own transcripts; messages there cannot be deleted from here." };
}

/** The desktop names them `entryIds`; the server names them `ids`. Send both, so either reader is right. */
export function serverDeletionArgs(args: unknown): Record<string, unknown> {
  const record = typeof args === "object" && args != null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const entryIds = Array.isArray(record.entryIds) ? record.entryIds.filter((id): id is string => typeof id === "string") : [];
  const ids = Array.isArray(record.ids) ? record.ids.filter((id): id is string => typeof id === "string") : [];
  const all = [...new Set([...ids, ...entryIds])];
  return { ...record, ids: all, entryIds: all };
}
