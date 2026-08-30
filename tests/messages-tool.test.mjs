import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-messages-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, sourcePath)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["node:sqlite"],
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("Apple timestamps decode from both the nanosecond and second shapes", async () => {
  const loaded = await loadModule("source/host/local-exec/messages-db.ts");
  try {
    const { appleDateToUnixMs, unixMsToAppleNanos, APPLE_EPOCH_OFFSET_SECONDS } = loaded.module;

    // A machine migrated across upgrades holds both shapes in one database.
    assert.equal(appleDateToUnixMs(0), null);
    assert.equal(appleDateToUnixMs(null), null);
    assert.equal(appleDateToUnixMs(undefined), null);
    assert.equal(appleDateToUnixMs(1), (1 + APPLE_EPOCH_OFFSET_SECONDS) * 1000);
    assert.equal(appleDateToUnixMs(1e9 * 800_000_000), (800_000_000 + APPLE_EPOCH_OFFSET_SECONDS) * 1000);
    assert.equal(appleDateToUnixMs(BigInt(1e9) * 800_000_000n), (800_000_000 + APPLE_EPOCH_OFFSET_SECONDS) * 1000);

    // The round trip is what the `since` filter depends on.
    const now = 1_800_000_000_000;
    assert.equal(appleDateToUnixMs(unixMsToAppleNanos(now)), now);
  } finally {
    await loaded.dispose();
  }
});

test("message bodies survive the attributedBody fallback", async () => {
  const loaded = await loadModule("source/host/local-exec/messages-db.ts");
  try {
    const { decodeMessageBody } = loaded.module;

    // Plain text wins whenever it is there.
    assert.equal(decodeMessageBody("hello", null), "hello");
    assert.equal(decodeMessageBody("hello", new Uint8Array([1, 2])), "hello");

    // Recent Messages versions leave `text` null and archive the body.
    const archived = Buffer.concat([
      Buffer.from([0x04, 0x0b]),
      Buffer.from("streamtypedNSString"),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
      Buffer.from("see you at eight"),
      Buffer.from([0x86, 0x84]),
    ]);
    assert.equal(decodeMessageBody(null, new Uint8Array(archived)), "see you at eight");

    // Nothing recoverable must read as null, never as an empty message.
    assert.equal(decodeMessageBody(null, null), null);
    assert.equal(decodeMessageBody(null, new Uint8Array()), null);
    assert.equal(decodeMessageBody("", null), null);
  } finally {
    await loaded.dispose();
  }
});

test("the transcript names unreadable bodies instead of showing silence", async () => {
  const loaded = await loadModule("source/host/local-exec/messages-db.ts");
  try {
    const { renderMessagesTranscript, boundMessagesLimit, MESSAGES_LIMIT_MAX } = loaded.module;

    assert.equal(renderMessagesTranscript([]), "No messages matched.");

    // Rendered oldest-first regardless of the newest-first query order.
    const rendered = renderMessagesTranscript([
      { rowid: 2, chat: "Ada", handle: "+15551234567", fromMe: false, service: "iMessage", at: 2000, text: "second", hasAttachments: false },
      { rowid: 1, chat: "Ada", handle: "+15551234567", fromMe: true, service: "iMessage", at: 1000, text: "first", hasAttachments: false },
      { rowid: 3, chat: "Ada", handle: "+15551234567", fromMe: false, service: "iMessage", at: 3000, text: null, hasAttachments: true },
      { rowid: 4, chat: "Ada", handle: "+15551234567", fromMe: false, service: "iMessage", at: 4000, text: null, hasAttachments: false },
    ]);
    const lines = rendered.split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[0], /you: first/);
    assert.match(lines[1], /\+15551234567: second/);
    assert.match(lines[2], /\(attachment only\)/);
    assert.match(lines[3], /\(unreadable message body\)/);

    // A model-supplied limit cannot pull the whole database.
    assert.equal(boundMessagesLimit(undefined), 25);
    assert.equal(boundMessagesLimit(1_000_000), MESSAGES_LIMIT_MAX);
    assert.equal(boundMessagesLimit(-5), 1);
    assert.equal(boundMessagesLimit("50"), 25);
  } finally {
    await loaded.dispose();
  }
});

test("the read query binds its filters rather than interpolating them", async () => {
  const loaded = await loadModule("source/host/local-exec/messages-db.ts");
  try {
    const { RECENT_MESSAGES_SQL } = loaded.module;
    // The contact reaches this query from model output, so it must never be
    // concatenated into the SQL.
    for (const parameter of [":contact", ":sinceAppleDate", ":limit"]) {
      assert.ok(RECENT_MESSAGES_SQL.includes(parameter), `${parameter} must be a bound parameter`);
    }
    assert.doesNotMatch(RECENT_MESSAGES_SQL, /\$\{/);
    assert.match(RECENT_MESSAGES_SQL, /ORDER BY m\.date DESC/);
  } finally {
    await loaded.dispose();
  }
});

test("a send failure is classified into advice the user can act on", async () => {
  const loaded = await loadModule("source/host/local-exec/messages-send.ts");
  try {
    const { classifySendFailure, sendFailureMessage, sendIMessage, SEND_IMESSAGE_APPLESCRIPT } = loaded.module;

    assert.equal(classifySendFailure("execution error: Not authorized to send Apple events (-1743)"), "not-authorized");
    assert.equal(classifySendFailure("Can't get participant \"nope\" (-1728)"), "unknown-recipient");
    assert.equal(classifySendFailure("Messages got an error: Can't get account 1"), "messages-unavailable");
    assert.equal(classifySendFailure("something else entirely"), "failed");

    assert.match(sendFailureMessage("not-authorized", "+1", ""), /Privacy & Security › Automation/);
    assert.match(sendFailureMessage("unknown-recipient", "bob", ""), /\+country format/);

    // The recipient and body go through argv, never into the script text.
    assert.match(SEND_IMESSAGE_APPLESCRIPT, /on run argv/);
    assert.doesNotMatch(SEND_IMESSAGE_APPLESCRIPT, /\$\{/);

    let captured;
    const ok = await sendIMessage({ to: "+15551234567", body: "hi" }, async (command, argv) => {
      captured = { command, argv };
      return { code: 0, stderr: "" };
    });
    assert.deepEqual(ok, { sent: true });
    assert.equal(captured.command, "/usr/bin/osascript");
    assert.deepEqual(captured.argv.slice(2), ["+15551234567", "hi"]);

    // A quote-heavy body is still passed as one argument, not escaped into the script.
    const nasty = `"; tell application "Finder" to delete every file --`;
    await sendIMessage({ to: "+1", body: nasty }, async (_c, argv) => {
      captured = argv;
      return { code: 0, stderr: "" };
    });
    assert.equal(captured[3], nasty);

    const empty = await sendIMessage({ to: "+1", body: "   " }, async () => ({ code: 0, stderr: "" }));
    assert.equal(empty.sent, false);
    assert.match(empty.error, /empty/);
  } finally {
    await loaded.dispose();
  }
});

test("Messages requests are described as two separate consent actions", async () => {
  const loaded = await loadModule("source/shared/messages-request.ts");
  try {
    const { describeMessagesOp, isMessagesOp } = loaded.module;

    // Reading and sending must never share an approval.
    assert.deepEqual(describeMessagesOp({ op: "read", contact: "Ada" }), { action: "read-messages", target: "Ada" });
    assert.deepEqual(describeMessagesOp({ op: "send", to: "+1", body: "hi" }), { action: "send-imessage", target: "+1" });

    // Reading everything is named as such, so the prompt cannot look narrow.
    assert.equal(describeMessagesOp({ op: "read" }).target, "all recent conversations");
    assert.equal(describeMessagesOp({ op: "read", contact: "  " }).target, "all recent conversations");

    assert.equal(describeMessagesOp({ op: "send", to: "+1" }), undefined);
    assert.equal(describeMessagesOp({ op: "delete" }), undefined);
    assert.equal(isMessagesOp({ op: "read", limit: "many" }), false);
  } finally {
    await loaded.dispose();
  }
});

// The unit tests above feed synthetic rows straight to the shaping function,
// which is exactly how a real defect slipped through: Apple stores message.date
// as nanoseconds since 2001 (~8.1e17 today), past Number.MAX_SAFE_INTEGER, and
// node:sqlite refuses to return such an integer at all — the read failed with
// "Value is too large to be represented as a JavaScript number" before any of
// this code ran. So this one exercises the real query against real SQLite.
test("the real query survives Apple's nanosecond timestamps", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const loaded = await loadModule("source/host/local-exec/messages-db.ts");
  try {
    const { RECENT_MESSAGES_SQL, shapeMessagesRow, appleDateToUnixMs } = loaded.module;
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, is_from_me INTEGER, service TEXT, date INTEGER,
                            text TEXT, attributedBody BLOB, cache_has_attachments INTEGER, handle_id INTEGER);
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      INSERT INTO handle VALUES (1, '+15551234567');
      INSERT INTO chat VALUES (1, '+15551234567', 'Ada');
      INSERT INTO message VALUES (1, 0, 'iMessage', 809694791870006016, 'see you at eight', NULL, 0, 1);
      INSERT INTO chat_message_join VALUES (1, 1);
    `);
    try {
      const rows = db.prepare(RECENT_MESSAGES_SQL).all({ contact: null, sinceAppleDate: null, limit: 25 });
      assert.equal(rows.length, 1, "the query must return the row, not throw on its timestamp");
      const shaped = shapeMessagesRow(rows[0]);
      assert.equal(shaped.text, "see you at eight");
      assert.equal(shaped.handle, "+15551234567");
      assert.equal(shaped.chat, "Ada");
      assert.equal(shaped.fromMe, false);
      // Precision loss from the REAL cast must stay far below a second.
      const expected = appleDateToUnixMs(809694791870006016);
      assert.ok(Math.abs(shaped.at - expected) < 1000, `timestamp drifted: ${shaped.at} vs ${expected}`);
      assert.ok(shaped.at > 1_780_000_000_000, "the timestamp must decode to a plausible date");

      // The contact filter still binds rather than interpolating.
      assert.equal(db.prepare(RECENT_MESSAGES_SQL).all({ contact: "Ada", sinceAppleDate: null, limit: 25 }).length, 1);
      assert.equal(db.prepare(RECENT_MESSAGES_SQL).all({ contact: "nobody", sinceAppleDate: null, limit: 25 }).length, 0);

      // The since filter binds a value of the same enormous magnitude, so it is
      // the same class of hazard as the column itself.
      const { unixMsToAppleNanos } = loaded.module;
      const messageAtMs = appleDateToUnixMs(809694791870006016);
      assert.equal(db.prepare(RECENT_MESSAGES_SQL).all({ contact: null, sinceAppleDate: unixMsToAppleNanos(messageAtMs - 60_000), limit: 25 }).length, 1, "a cutoff before the message must include it");
      assert.equal(db.prepare(RECENT_MESSAGES_SQL).all({ contact: null, sinceAppleDate: unixMsToAppleNanos(messageAtMs + 60_000), limit: 25 }).length, 0, "a cutoff after it must exclude it");
    } finally { db.close(); }
  } finally {
    await loaded.dispose();
  }
});
