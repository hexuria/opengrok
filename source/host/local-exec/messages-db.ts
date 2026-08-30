import { statSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reading the Messages database is a macOS privacy-gated operation. The file is
 * mode-readable and owned by the user, so a plain permission check says yes;
 * the kernel refuses at open() unless the calling binary holds Full Disk
 * Access. Everything here is shaped around telling that refusal apart from a
 * missing or broken database, because the two need opposite advice.
 */
export const MESSAGES_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

export const MESSAGES_FULL_DISK_ACCESS_HINT =
  "OpenGrok does not have Full Disk Access, which macOS requires to read Messages. "
  + "Grant it in System Settings › Privacy & Security › Full Disk Access, enable OpenGrok, "
  + "then quit and reopen the app. Note that reinstalling OpenGrok revokes the grant, "
  + "because the permission is tied to the app's code signature.";

export const MESSAGES_DB_MISSING_HINT =
  "This Mac has no Messages database at ~/Library/Messages/chat.db. "
  + "Messages has to have been opened and signed in at least once.";

export type MessagesAccess = "ok" | "no-permission" | "missing";

/** Apple stores message timestamps against 2001-01-01, not the Unix epoch. */
export const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

/**
 * Ventura and later store nanoseconds; older databases store seconds, and both
 * shapes turn up on a machine that has been migrated across upgrades. Seconds
 * since 2001 stay below 1e10 until the year 2318, so the magnitude separates
 * them without having to probe the schema version.
 */
export function appleDateToUnixMs(raw: number | bigint | null | undefined): number | null {
  if (raw == null) return null;
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (!Number.isFinite(value) || value <= 0) return null;
  const seconds = value > 1e10 ? value / 1e9 : value;
  return Math.round((seconds + APPLE_EPOCH_OFFSET_SECONDS) * 1000);
}

export function unixMsToAppleNanos(unixMs: number): number {
  return Math.round((unixMs / 1000 - APPLE_EPOCH_OFFSET_SECONDS) * 1e9);
}

/**
 * `message.text` is null for anything composed in a recent Messages version,
 * which stores the body as an archived NSAttributedString in `attributedBody`.
 * Decoding a typedstream properly is a project of its own; the body is stored
 * in it as plain UTF-8 preceded by a length, so this lifts the longest such run
 * and leaves the rest alone. A body it cannot recover comes back null and is
 * reported as unreadable rather than as an empty message.
 */
export function decodeMessageBody(text: unknown, attributedBody: unknown): string | null {
  if (typeof text === "string" && text.length > 0) return text;
  if (!(attributedBody instanceof Uint8Array) || attributedBody.length === 0) return null;
  const decoded = Buffer.from(attributedBody).toString("utf8");
  const marker = decoded.indexOf("NSString");
  const searchable = marker < 0 ? decoded : decoded.slice(marker + "NSString".length);
  // The archive frames the body with control bytes, and its length and class
  // markers are not valid UTF-8 so they decode to U+FFFD. Both are separators
  // here, so the body comes back without the bytes that surrounded it.
  let best: string | null = null;
  for (const candidate of searchable.split(/[\u0000-\u001f\u007f\ufffd]+/)) {
    const trimmed = candidate.replace(/^[+*]+/, "").trim();
    if (trimmed.length < 2) continue;
    if (/^(NS|__k|IM)[A-Za-z]/.test(trimmed)) continue;
    if (best == null || trimmed.length > best.length) best = trimmed;
  }
  return best;
}

/**
 * The database file is present and mode-readable even when macOS will refuse to
 * open it, so stat cannot answer this — only an actual open can. EPERM on a file
 * that stats cleanly is the privacy refusal; ENOENT is a Mac that has never run
 * Messages.
 */
export function classifyMessagesAccess(path: string = MESSAGES_DB_PATH): MessagesAccess {
  try {
    statSync(path);
  } catch {
    return "missing";
  }
  try {
    closeSync(openSync(path, "r"));
    return "ok";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "missing" : "no-permission";
  }
}

export function messagesAccessHint(access: MessagesAccess): string | undefined {
  if (access === "no-permission") return MESSAGES_FULL_DISK_ACCESS_HINT;
  if (access === "missing") return MESSAGES_DB_MISSING_HINT;
  return undefined;
}

export interface MessagesRow {
  readonly rowid: number;
  readonly chat: string;
  readonly handle: string | null;
  readonly fromMe: boolean;
  readonly service: string | null;
  readonly at: number | null;
  readonly text: string | null;
  readonly hasAttachments: boolean;
}

export const MESSAGES_LIMIT_MAX = 200;
export const MESSAGES_LIMIT_DEFAULT = 25;

export function boundMessagesLimit(limit: unknown): number {
  const value = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : MESSAGES_LIMIT_DEFAULT;
  return Math.min(MESSAGES_LIMIT_MAX, Math.max(1, value));
}

/**
 * Ordered newest-first so a small limit returns the recent conversation rather
 * than the oldest messages on record; callers reverse it for display. The
 * contact and since filters are bound parameters, never interpolated — the
 * contact string reaches here from model output.
 */
export const RECENT_MESSAGES_SQL = `
SELECT
  m.ROWID            AS rowid,
  m.is_from_me       AS fromMe,
  m.service          AS service,
  -- Apple stores this as nanoseconds since 2001, which today is ~8.1e17 —
  -- past Number.MAX_SAFE_INTEGER, so node:sqlite refuses to return it at all
  -- ("Value is too large to be represented as a JavaScript number") and the
  -- whole read fails. A double loses sub-microsecond precision we never use.
  CAST(m.date AS REAL) AS appleDate,
  m.text             AS text,
  m.attributedBody   AS attributedBody,
  m.cache_has_attachments AS hasAttachments,
  h.id               AS handle,
  COALESCE(NULLIF(c.display_name, ''), c.chat_identifier) AS chat
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE (:contact IS NULL
       OR h.id = :contact
       OR c.chat_identifier = :contact
       OR LOWER(COALESCE(c.display_name, '')) LIKE LOWER('%' || :contact || '%'))
  AND (:sinceAppleDate IS NULL OR m.date >= :sinceAppleDate)
ORDER BY m.date DESC
LIMIT :limit
`.trim();

export interface MessagesQueryRow {
  readonly rowid: number;
  readonly fromMe: number;
  readonly service: string | null;
  readonly appleDate: number | bigint | null;
  readonly text: string | null;
  readonly attributedBody: Uint8Array | null;
  readonly hasAttachments: number | null;
  readonly handle: string | null;
  readonly chat: string | null;
}

export function shapeMessagesRow(row: MessagesQueryRow): MessagesRow {
  return {
    rowid: Number(row.rowid),
    chat: row.chat ?? row.handle ?? "unknown",
    handle: row.handle,
    fromMe: row.fromMe === 1,
    service: row.service,
    at: appleDateToUnixMs(row.appleDate),
    text: decodeMessageBody(row.text, row.attributedBody),
    hasAttachments: row.hasAttachments === 1,
  };
}

/**
 * A transcript the model reads, not a table it parses: one line per message,
 * oldest first, with unrecoverable bodies named rather than blank so it never
 * reports an empty message as silence.
 */
export function renderMessagesTranscript(rows: readonly MessagesRow[]): string {
  if (rows.length === 0) return "No messages matched.";
  return [...rows]
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .map((row) => {
      const when = row.at == null ? "unknown time" : new Date(row.at).toISOString();
      const who = row.fromMe ? "you" : row.handle ?? row.chat;
      const body = row.text ?? (row.hasAttachments ? "(attachment only)" : "(unreadable message body)");
      const attachment = row.text != null && row.hasAttachments ? " (has attachment)" : "";
      return `[${when}] ${row.chat} — ${who}: ${body}${attachment}`;
    })
    .join("\n");
}
