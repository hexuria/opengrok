import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { copyLockedSqliteDb } from "../extensions/box-store-sync/sqlite-snapshot.js";
import {
  MESSAGES_DB_PATH,
  RECENT_MESSAGES_SQL,
  boundMessagesLimit,
  classifyMessagesAccess,
  messagesAccessHint,
  renderMessagesTranscript,
  shapeMessagesRow,
  unixMsToAppleNanos,
  type MessagesQueryRow,
  type MessagesRow,
} from "./messages-db.js";
import { sendIMessage } from "./messages-send.js";
import type { MessagesOp } from "../../shared/messages-request.js";

/**
 * Executes the Messages operations here, on the Mac, because the agent host
 * runs inside the box and cannot see the user's home directory at all.
 */
export type MessagesOpResult =
  | { readonly ok: true; readonly kind: "read"; readonly transcript: string; readonly count: number }
  | { readonly ok: true; readonly kind: "send"; readonly to: string }
  | { readonly ok: false; readonly error: string };

/**
 * The live database is in WAL mode and Messages holds it open, so it must never
 * be opened in place — the snapshot is the same locked-copy routine the box
 * store sync uses. The copy lands in a private temp directory and is removed
 * before returning, including on the failure paths: it is a verbatim copy of
 * the user's message history and must not outlive the read.
 */
export function readMessages(args: {
  readonly contact?: string;
  readonly limit?: number;
  readonly sinceMs?: number;
  readonly dbPath?: string;
}): MessagesOpResult {
  const dbPath = args.dbPath ?? MESSAGES_DB_PATH;
  const access = classifyMessagesAccess(dbPath);
  const hint = messagesAccessHint(access);
  if (hint !== undefined) return { ok: false, error: hint };

  const staging = mkdtempSync(join(tmpdir(), "opengrok-messages-"));
  const snapshot = join(staging, "chat.db");
  try {
    if (!copyLockedSqliteDb({ srcPath: dbPath, destPath: snapshot })) {
      return { ok: false, error: "Could not take a consistent snapshot of the Messages database. Messages may be mid-write; try again." };
    }
    const db = new DatabaseSync(snapshot, { readOnly: true });
    try {
      const contact = args.contact?.trim();
      const rows = db.prepare(RECENT_MESSAGES_SQL).all({
        contact: contact != null && contact.length > 0 ? contact : null,
        sinceAppleDate: args.sinceMs == null ? null : unixMsToAppleNanos(args.sinceMs),
        limit: boundMessagesLimit(args.limit),
      }) as unknown as MessagesQueryRow[];
      const shaped: MessagesRow[] = rows.map(shapeMessagesRow);
      return { ok: true, kind: "read", transcript: renderMessagesTranscript(shaped), count: shaped.length };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, error: `Reading Messages failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function runMessagesOp(op: MessagesOp): Promise<MessagesOpResult> {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Messages is only available on macOS; this computer is not a Mac." };
  }
  if (op.op === "send") {
    const result = await sendIMessage({ to: op.to, body: op.body });
    return result.sent ? { ok: true, kind: "send", to: op.to.trim() } : { ok: false, error: result.error ?? "The send failed." };
  }
  return readMessages({
    ...(op.contact === undefined ? {} : { contact: op.contact }),
    ...(op.limit === undefined ? {} : { limit: op.limit }),
    ...(op.sinceMs === undefined ? {} : { sinceMs: op.sinceMs }),
  });
}
