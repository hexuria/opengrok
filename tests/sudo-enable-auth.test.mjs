import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadAuth() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-sudo-auth-"));
  const outfile = path.join(dir, "sudo-enable-auth.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/electron-main/askpass/sudo-enable-auth.ts")], outfile, bundle: true, format: "esm", platform: "node", target: "node22" });
  const mod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { mod, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Touch ID success enables without touching the password path", async () => {
  const { mod, dispose } = await loadAuth();
  try {
    let sudoRan = false;
    const r = await mod.authorizeSudoEnable({
      platform: "darwin",
      canPromptTouchID: () => true,
      promptTouchID: async () => {},
      runSudoValidate: async () => { sudoRan = true; return 0; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.method, "touch-id");
    assert.equal(sudoRan, false, "the password path must not run when Touch ID succeeds");
  } finally { dispose(); }
});

test("Touch ID failure falls back to the validated sudo password", async () => {
  const { mod, dispose } = await loadAuth();
  try {
    let sudoRan = false;
    const r = await mod.authorizeSudoEnable({
      platform: "darwin",
      canPromptTouchID: () => true,
      promptTouchID: async () => { throw new Error("cancelled"); },
      runSudoValidate: async () => { sudoRan = true; return 0; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.method, "password");
    assert.equal(sudoRan, true);
  } finally { dispose(); }
});

test("no biometric hardware goes straight to the password path", async () => {
  const { mod, dispose } = await loadAuth();
  try {
    let touchTried = false;
    const r = await mod.authorizeSudoEnable({
      platform: "darwin",
      canPromptTouchID: () => false,
      promptTouchID: async () => { touchTried = true; },
      runSudoValidate: async () => 0,
    });
    assert.equal(r.ok, true);
    assert.equal(r.method, "password");
    assert.equal(touchTried, false, "promptTouchID must not run when canPromptTouchID is false");
  } finally { dispose(); }
});

test("Linux never tries Touch ID and uses the password path", async () => {
  const { mod, dispose } = await loadAuth();
  try {
    let touchTried = false;
    const r = await mod.authorizeSudoEnable({
      platform: "linux",
      canPromptTouchID: () => { touchTried = true; return true; },
      promptTouchID: async () => {},
      runSudoValidate: async () => 0,
    });
    assert.equal(r.ok, true);
    assert.equal(r.method, "password");
    assert.equal(touchTried, false, "non-mac never consults Touch ID");
  } finally { dispose(); }
});

test("a wrong password (non-zero sudo exit) leaves the feature off with a message", async () => {
  const { mod, dispose } = await loadAuth();
  try {
    const r = await mod.authorizeSudoEnable({
      platform: "linux",
      canPromptTouchID: () => false,
      promptTouchID: async () => {},
      runSudoValidate: async () => 1,
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /not accepted|stay off/i);
  } finally { dispose(); }
});
