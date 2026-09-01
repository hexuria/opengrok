import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as patch from "../scripts/lib/router-renderer-patch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pinnedPath = path.join(repoRoot, "src/app/dist/renderer/assets/index-UbX-y3il.js");
let pinned = null;
try { pinned = await readFile(pinnedPath, "utf8"); } catch { /* recovered bundle absent */ }

// These assert the SHIPPED patch, not the recovered mirror (frontend/ never
// ships). The one-consent-model B1/B2 changes live here or nowhere.

test("the Mac switch is a single On/Off toggle, not a three-way ask control", () => {
  const src = patch.COMPONENT_SOURCE;
  assert.match(src, /This computer accepts bot commands/);
  // Binary by construction: the row drives the bundle's own role="switch"
  // component, mapping anything that is not "never" to on.
  assert.match(src, /isChecked:s\.permission!=null&&s\.permission!=="never"/);
  assert.match(src, /onToggle:\(\)=>setPerm\(s\.permission==="never"\?"always":"never"\)/);
  // The old three-way execution control and its copy are gone. ("Ask every
  // time" / value:"ask" legitimately remain in the remote-control mode picker.)
  assert.doesNotMatch(src, /Execution on this computer/);
});

test("card Always/Never no longer flips the local Mac switch (shipped bundle)", { skip: pinned == null }, () => {
  // Upstream flipped the machine permission from the card; the patch removes it.
  assert.match(pinned, /async function OLn\(n\)\{let e=n\.resolution;if\(e==="always"\|\|e==="never"\)try\{await n\.setPermission/);
  const patched = patch.patchOriginalCardLocalFlip(pinned);
  assert.doesNotMatch(patched, /if\(e==="always"\|\|e==="never"\)try\{await n\.setPermission/);
  // The resolution still reaches the server and allow-once still records.
  assert.match(patched, /await n\.resolveLocalToolPermission\(\{entryId:n\.entryId/);
  assert.match(patched, /e==="allow-once"&&await n\.recordApproval/);
  // Applying twice must throw (anchor consumed) - proves exactly-once.
  assert.throws(() => patch.patchOriginalCardLocalFlip(patched));
});

test("the local-tool card offers Allow for this session (shipped bundle)", { skip: pinned == null }, () => {
  assert.match(pinned, /z=\[_,q,F\],e\[38\]=q/);
  const patched = patch.patchOriginalCardSessionTier(pinned);
  assert.match(patched, /Allow for this session/);
  assert.match(patched, /E\("allow-session"\)/);
  assert.match(patched, /until the server restarts/);
  assert.throws(() => patch.patchOriginalCardSessionTier(patched));
});

test("the daemon on/off helper maps enrolled legacy values to on, never to off", async () => {
  const { build } = await import("esbuild");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const dir = await mkdtemp(path.join(os.tmpdir(), "daemon-onoff-"));
  try {
    const out = path.join(dir, "d.mjs");
    await build({ entryPoints: [path.join(repoRoot, "source/host/local-exec/local-exec-daemon.ts")], outfile: out, bundle: true, format: "esm", platform: "node", external: ["electron"] });
    const { isLocalToolPermissionOn } = await import(pathToFileURL(out).href);
    assert.equal(isLocalToolPermissionOn("always"), true);
    assert.equal(isLocalToolPermissionOn("ask"), true, "an enrolled machine at legacy 'ask' stays on");
    assert.equal(isLocalToolPermissionOn("never"), false, "only an explicit never is the off kill switch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the per-agent auto-review widget is injected and is valid JS", async () => {
  const src = await readFile(path.join(repoRoot, "scripts/lib/router-renderer-patch.mjs"), "utf8");
  const m = src.match(/const AGENT_AUTOREVIEW_HELPER = ([\s\S]*?);\n\nconst ACCOUNT_CARD_HELPER/);
  assert.ok(m, "AGENT_AUTOREVIEW_HELPER must exist");
  const js = (0, eval)(m[1]);
  const acorn = await import("acorn");
  acorn.parse(js, { ecmaVersion: "latest" });
  // It drives the real edges and scopes itself to the agent settings pane.
  assert.match(js, /getAgentAutoReview/);
  assert.match(js, /setAgentAutoReview/);
  assert.match(js, /deleteAgentAutoReview/);
  // The pane has no id of its own; the open agent comes from the selected item.
  assert.match(js, /\.sand-agent-settings/);
  assert.match(js, /aria-current/);
  // And it is actually wired into the shipped prepend chain.
  assert.match(src, /\+ AGENT_AUTOREVIEW_HELPER \+ patched;/);
});

test("injected settings components only reference symbols that exist in the panel chunk", { skip: pinned == null }, async () => {
  // COMPONENT_SOURCE is spliced into the chunk holding the settings panel,
  // which is NOT the main index chunk. Referencing a helper that lives in
  // another chunk yields `undefined` at render and takes the whole app down
  // with it, so every bundle symbol used here must be resolvable there.
  const assetsRoot = path.join(repoRoot, "src/app/dist/renderer/assets");
  const names = (await readdir(assetsRoot)).filter((n) => n.endsWith(".js"));
  let panel = null;
  for (const name of names) {
    const source = await readFile(path.join(assetsRoot, name), "utf8");
    if (source.includes("function Sa(s){")) { panel = source; break; }
  }
  assert.ok(panel, "settings panel chunk not found");

  const src = patch.COMPONENT_SOURCE;
  const referenced = new Set();
  for (const m of src.matchAll(/a\.jsxs?\(\s*([A-Za-z_$][\w$]*)/g)) referenced.add(m[1]);
  const declaredHere = new Set();
  for (const m of src.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declaredHere.add(m[1]);

  const missing = [...referenced]
    .filter((id) => !declaredHere.has(id))
    // `$` is a valid identifier character but not a word character, so \b
    // cannot delimit names like `$e` and would report them missing. Bound on
    // JS identifier characters instead, and escape the name before use.
    .filter((id) => {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`(?:^|[^\\w$])${escaped}(?![\\w$])`).test(panel);
    });
  assert.deepEqual(missing, [], `these symbols are not in the settings panel chunk: ${missing.join(", ")}`);
});
