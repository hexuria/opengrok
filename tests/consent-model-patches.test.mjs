import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(src, /RLocalPerm=\[\{value:"always",label:"On"\},\{value:"never",label:"Off"\}\]/);
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
