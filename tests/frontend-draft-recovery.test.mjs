import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-draft-state-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/draft-state.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const persistence = { read: async () => null, write: async () => {}, clear: async () => {} };
const chip = { prompt: "", attachments: [{ path: "/tmp/staged/a.pdf", name: "a.pdf" }] };

// A failed send parks its draft in the recovery slot so the person can retry.
// Emptying the composer on purpose — removing the last chip, deleting the
// text — must discard that recovery too. Before this, the empty update nulled
// only the draft, the recovery surfaced in its place, and the next removal
// returned early because there was no draft left to clear: the chip was immortal.
test("explicitly emptying the composer discards the failed-send recovery", async () => {
  const { loaded, cleanup } = await load();
  try {
    const store = loaded.createComposerDraftStateStore(persistence);
    await store.restore("acct");
    const snapshots = store.snapshotsFor("agent");

    store.recoverDraft("agent", chip);
    assert.deepEqual(snapshots.get().draft, chip, "with no draft the recovered send becomes the draft");
    store.setDraft("agent", { prompt: "", attachments: [] });
    assert.deepEqual(snapshots.get(), { draft: null, recovery: null });

    store.setDraft("agent", { prompt: "typing", attachments: [] });
    store.recoverDraft("agent", chip);
    assert.deepEqual(snapshots.get().recovery, chip, "behind a live draft the failed send waits as recovery");
    store.setDraft("agent", { prompt: "typing more", attachments: [] });
    assert.deepEqual(snapshots.get().recovery, chip, "a non-empty edit keeps the recovery");
    store.setDraft("agent", { prompt: "", attachments: [] });
    assert.deepEqual(snapshots.get(), { draft: null, recovery: null }, "an explicit clear drops both");

    store.setDraft("agent", { prompt: "", attachments: [] });
    assert.deepEqual(snapshots.get(), { draft: null, recovery: null }, "clearing an already empty composer is a no-op");
  } finally { await cleanup(); }
});
