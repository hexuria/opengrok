import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-unread-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/unread.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// Official places the divider only when the coworker spoke after you last
// looked, and clears it otherwise — that is what makes it vanish when you
// return a second time (bundle pVn @5723796).
test("the anchor appears only when there is activity after the last look", async () => {
  const { loaded, cleanup } = await load();
  try {
    assert.equal(loaded.resolveUnreadAnchor({ lastViewedAt: 1000, lastActivityAt: 2000 }), 1000, "spoke while away");
    assert.equal(loaded.resolveUnreadAnchor({ lastViewedAt: 2000, lastActivityAt: 2000 }), null, "already caught up");
    assert.equal(loaded.resolveUnreadAnchor({ lastViewedAt: 3000, lastActivityAt: 2000 }), null, "read more recently than it spoke");
    assert.equal(loaded.resolveUnreadAnchor({ lastActivityAt: 2000 }), 0, "never looked, but it has spoken: everything is new");
    assert.equal(loaded.resolveUnreadAnchor({ lastViewedAt: 1000 }), null, "nothing has happened");
    assert.equal(loaded.resolveUnreadAnchor(null), null);
    // Junk timestamps are treated as "never", not as an anchor.
    assert.equal(loaded.resolveUnreadAnchor({ lastViewedAt: -5, lastActivityAt: Number.NaN }), null);
    assert.deepEqual([0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined].map(loaded.timestampOrZero), [0, 0, 0, 0, 0, 0]);
  } finally { await cleanup(); }
});

test("the divider lands in front of the first unread message and counts only what someone else said", async () => {
  const { loaded, cleanup } = await load();
  try {
    const entries = [
      { kind: "message", id: "a", role: "assistant", timestampMs: 500 },
      { kind: "message", id: "b", role: "user", timestampMs: 1500 },
      { kind: "message", id: "c", role: "assistant", timestampMs: 1600 },
      { kind: "notice", id: "n", timestampMs: 1700 },
      { kind: "send-message", id: "d", timestampMs: 1800 },
    ];
    const withDivider = loaded.withUnreadDivider(entries, 1000);
    assert.deepEqual(withDivider.map((entry) => entry.id), ["a", "b", loaded.UNREAD_DIVIDER_ID, "c", "n", "d"], "the divider sits before c, the first thing the coworker said after the anchor");
    const divider = withDivider[2];
    assert.equal(divider.kind, "unread-divider");
    assert.equal(divider.newMessageCount, 2, "c and d — the person's own message and the notice do not count");
    // Nothing to mark: the same array comes back, so React sees no change.
    assert.equal(loaded.withUnreadDivider(entries, null), entries);
    assert.equal(loaded.withUnreadDivider(entries, 9000), entries);
  } finally { await cleanup(); }
});

test("the pill label matches official", async () => {
  const { loaded, cleanup } = await load();
  try {
    assert.equal(loaded.newMessagesLabel(1), "1 new message");
    assert.equal(loaded.newMessagesLabel(2), "2 new messages");
    assert.equal(loaded.newMessagesLabel(13), "13 new messages");
  } finally { await cleanup(); }
});

test("a server that speaks unread is the authority; the device record only stands in when it does not", async () => {
  const { loaded, cleanup } = await load();
  try {
    const store = new Map();
    globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } };
    const entries = [{ kind: "message", id: "m", role: "assistant", timestampMs: 5000 }];
    // Server speaks unread (lastActivityAt present): its values are used verbatim, whatever this device remembers.
    loaded.recordLocalLastViewedAt("bot", 9000);
    assert.equal(loaded.resolveUnreadAnchorForAgent("bot", { lastViewedAt: 4000, lastActivityAt: 5000 }, entries), 4000, "server says unread since 4000; a device record of 9000 does not override a deliberate Mark as Unread");
    assert.equal(loaded.resolveUnreadAnchorForAgent("bot", { lastViewedAt: 5000, lastActivityAt: 5000 }, entries), null, "server says caught up");
    assert.equal(loaded.resolveUnreadAnchorForAgent("bot", { lastViewedAt: 0, lastActivityAt: 5000 }, entries), 0, "server: never viewed, spoke — everything is new");
    // Server without the fields at all: the device record decides, seeding on first look.
    store.clear();
    assert.equal(loaded.resolveUnreadAnchorForAgent("bot2", {}, entries), null);
    assert.equal(loaded.localLastViewedAt("bot2"), 5000, "seeded on that first look");
    const later = [...entries, { kind: "message", id: "m2", role: "assistant", timestampMs: 9000 }];
    assert.equal(loaded.resolveUnreadAnchorForAgent("bot2", {}, later), 5000, "something arrived since");
    loaded.recordLocalLastViewedAt("bot2", 100);
    assert.equal(loaded.localLastViewedAt("bot2"), 5000, "recording never moves backwards");
    delete globalThis.localStorage;
  } finally { await cleanup(); }
});
