import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath, name) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `grok-native-${name}-`));
  const output = path.join(temporary, `${name}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, sourcePath)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("inspect without a launcher reports missing/invalid instead of throwing", async () => {
  const loaded = await loadModule("source/electron-main/onepassword/onepassword-cli-runtime.ts", "op");
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grok-op-inspect-"));
    try {
      const runtime = new loaded.module.SandOnePasswordCliRuntime({
        installRoot: path.join(dir, "managed"),
        launcherPath: path.join(dir, "missing-launcher"),
        platform: "darwin",
        arch: "arm64",
        systemPaths: [path.join(dir, "no-such-op")],
        runProcess: async () => {
          throw new Error("inspect must not spawn when every candidate is missing");
        },
      });
      const inspection = await runtime.inspect(new AbortController().signal);
      assert.equal(inspection.platformSupported, true);
      assert.equal(inspection.selected, null);
      assert.equal(inspection.detail, "No verified 1Password CLI is ready");
      assert.ok(inspection.candidates.length >= 2);
      assert.ok(inspection.candidates.every((candidate) => candidate.state === "missing"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await loaded.dispose();
  }
});

test("inspect without a launcher still selects a system op", async () => {
  const loaded = await loadModule("source/electron-main/onepassword/onepassword-cli-runtime.ts", "op-ready");
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grok-op-system-"));
    try {
      const opPath = path.join(dir, "op");
      writeFileSync(opPath, "#!/bin/sh\n");
      chmodSync(opPath, 0o755);
      const resolvedOp = realpathSync(opPath);
      const spawned = [];
      const runtime = new loaded.module.SandOnePasswordCliRuntime({
        installRoot: path.join(dir, "managed"),
        launcherPath: path.join(dir, "missing-launcher"),
        platform: "darwin",
        arch: "arm64",
        systemPaths: [opPath],
        runProcess: async (file, args) => {
          spawned.push({ file, args: [...args] });
          assert.equal(file, resolvedOp);
          assert.deepEqual([...args], ["--version"]);
          return { stdout: "2.35.0\n", stderr: "" };
        },
      });
      const inspection = await runtime.inspect(new AbortController().signal);
      assert.equal(inspection.selected?.source, "system");
      assert.equal(inspection.selected?.path, opPath);
      assert.equal(inspection.selected?.version, "2.35.0");
      assert.equal(inspection.selected?.state, "ready");
      assert.equal(inspection.detail, "System CLI ready");
      assert.equal(spawned.length, 1);
      assert.doesNotMatch(loaded.module.SAND_OP_LAUNCHER_CODESIGN_REQUIREMENT, /DCNK4UB866/);
      assert.deepEqual([...loaded.module.ONEPASSWORD_SYSTEM_CLI_PATHS], [
        "/opt/homebrew/bin/op",
        "/usr/local/bin/op",
        "/usr/bin/op",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await loaded.dispose();
  }
});

test("inspect without a launcher marks an unreadable system op invalid", async () => {
  const loaded = await loadModule("source/electron-main/onepassword/onepassword-cli-runtime.ts", "op-invalid");
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grok-op-invalid-"));
    try {
      const opPath = path.join(dir, "op");
      writeFileSync(opPath, "#!/bin/sh\n");
      chmodSync(opPath, 0o755);
      const runtime = new loaded.module.SandOnePasswordCliRuntime({
        installRoot: path.join(dir, "managed"),
        launcherPath: path.join(dir, "missing-launcher"),
        platform: "darwin",
        arch: "arm64",
        systemPaths: [opPath],
        runProcess: async () => ({ stdout: "not-a-version\n", stderr: "" }),
      });
      const inspection = await runtime.inspect(new AbortController().signal);
      assert.equal(inspection.selected, null);
      const system = inspection.candidates.find((candidate) => candidate.source === "system");
      assert.equal(system?.state, "invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await loaded.dispose();
  }
});

test("synthetic 1Password provisioning runs op args without a launcher prefix", async () => {
  const loaded = await loadModule("source/electron-main/onepassword/onepassword-cli-dev-controls.ts", "op-synth");
  try {
    const result = await loaded.module.runSyntheticOnePasswordProvisioningExercise();
    assert.equal(result.isOk, true);
    assert.equal(result.action, "synthetic-provisioning");
    assert.equal(result.accountCount, 1);
    assert.equal(result.vaultCount, 1);
  } finally {
    await loaded.dispose();
  }
});

test("WebAuthn stays fail-closed when no signer binary is present", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/webauthn/signer.ts", "webauthn");
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grok-webauthn-"));
    try {
      assert.equal(
        loaded.module.resolveWebAuthnSignerPath({ isPackaged: false, repoRoot: dir }),
        undefined,
      );
      assert.equal(
        loaded.module.resolveWebAuthnSignerPath({ isPackaged: true, repoRoot: dir }),
        undefined,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await loaded.dispose();
  }
});

test("packaging does not copy Anysphere Mach-Os into dist/native", async () => {
  const asar = await readFile(path.join(repoRoot, "scripts/lib/build-asar.mjs"), "utf8");
  const cleanBuild = await readFile(path.join(repoRoot, "scripts/lib/clean-build.mjs"), "utf8");
  const verify = await readFile(path.join(repoRoot, "scripts/verify.mjs"), "utf8");
  const bridge = await readFile(path.join(repoRoot, "source/electron-main/onepassword/onepassword-provisioning-bridge.ts"), "utf8");
  const runtime = await readFile(path.join(repoRoot, "source/electron-main/onepassword/onepassword-cli-runtime.ts"), "utf8");
  const verification = await readFile(path.join(repoRoot, "scripts/lib/macos-package-verification.mjs"), "utf8");

  assert.doesNotMatch(asar, /for \(const directory of \["deps", "native"\]\)/);
  assert.match(asar, /await rm\(path\.join\(stageRoot, "dist", "native"\)/);
  assert.match(cleanBuild, /mode: "system-runtime"/);
  assert.match(cleanBuild, /Anysphere Mach-Os from 0\.18 are not copied/);
  assert.doesNotMatch(cleanBuild, /ABI-matched native executables are copied from the checksum-pinned 0\.18 runtime/);
  assert.doesNotMatch(verify, /requirePath\(path\.join\(builtAsarUnpacked, "dist", "native", "sand-webauthn-signer"\)\)/);
  assert.match(verify, /Packaged unpacked runtime still contains \$\{helper\}/);
  assert.match(bridge, /this\.executor\(opPath, args,/);
  assert.doesNotMatch(bridge, /launcherPath = await this\.options\.runtime\.resolveVerifiedLauncherPath/);
  assert.doesNotMatch(runtime, /certificate leaf\[subject\.OU\] = "DCNK4UB866"/);
  assert.doesNotMatch(verification, /"dist\/native"/);
});
