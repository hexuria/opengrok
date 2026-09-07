import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-scope-fence-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/prompt-scope-fence.ts")],
    outfile, bundle: true, format: "esm", platform: "node",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// Switching agents installs a fence so a transaction still in flight from the
// previous agent cannot write its text into the new agent's draft. The fence
// also used to demand a `uiEvent` meta, which ProseMirror sets on cut, paste
// and drop and NEVER on typing: after switching agents every keystroke was
// swallowed, the draft stayed empty, the send button never appeared and Enter
// did nothing. Typing must release the fence; the stale document must not.
test("the prompt's scope fence releases on a genuine edit and holds for stale or cleared documents", async () => {
  const { loaded, cleanup } = await load();
  try {
    const before = JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] });
    const typed = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "h" }] }] });

    assert.equal(loaded.scopeFenceReleasedBy(typed, before, false), true, "one typed character releases the fence");
    assert.equal(loaded.scopeFenceReleasedBy(before, before, false), false, "the document captured at the switch is the stale one; keep holding");
    assert.equal(loaded.scopeFenceReleasedBy(typed, before, true), false, "the reset that loads the new agent's draft is not a user edit");
    assert.equal(loaded.scopeFenceReleasedBy(before, before, true), false);

    const pasted = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "pasted" }] }] });
    assert.equal(loaded.scopeFenceReleasedBy(pasted, before, false), true, "paste and drop still release it, as they always did");
  } finally { await cleanup(); }
});
