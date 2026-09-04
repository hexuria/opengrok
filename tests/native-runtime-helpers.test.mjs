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

function darwinRuntime(mod, dir, extra = {}) {
  return new mod.SandOnePasswordCliRuntime({
    installRoot: path.join(dir, "managed"),
    platform: "darwin",
    arch: "arm64",
    systemPaths: extra.systemPaths ?? [path.join(dir, "no-such-op")],
    runProcess: extra.runProcess,
  });
}

test("inspect without a launcher reports missing/invalid instead of throwing", async () => {
  const loaded = await loadModule("source/electron-main/onepassword/onepassword-cli-runtime.ts", "op");
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grok-op-inspect-"));
    try {
      const runtime = darwinRuntime(loaded.module, dir, {
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

test("inspect without a launcher still selects a codesigned system op", async () => {
  const loaded = await loadModule("source/electron-main/onepassword/onepassword-cli-runtime.ts", "op-ready");
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grok-op-system-"));
    try {
      const opPath = path.join(dir, "op");
      writeFileSync(opPath, "#!/bin/sh\n");
      chmodSync(opPath, 0o755);
      const resolvedOp = realpathSync(opPath);
      const spawned = [];
      const runtime = darwinRuntime(loaded.module, dir, {
        systemPaths: [opPath],
        runProcess: async (file, args) => {
          spawned.push({ file, args: [...args] });
          if (file === "/usr/bin/codesign") {
            assert.ok(args.includes(`-R=${loaded.module.ONEPASSWORD_CODESIGN_REQUIREMENT}`));
            assert.equal(args.at(-1), resolvedOp);
            return { stdout: "", stderr: "" };
          }
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
      assert.equal(inspection.selected?.signature, "verified");
      assert.equal(inspection.detail, "System CLI ready");
      assert.equal(spawned[0]?.file, "/usr/bin/codesign");
      assert.equal(spawned[1]?.file, resolvedOp);
      assert.match(loaded.module.ONEPASSWORD_CODESIGN_REQUIREMENT, /2BUA8C4S2C/);
      assert.doesNotMatch(loaded.module.ONEPASSWORD_CODESIGN_REQUIREMENT, /DCNK4UB866/);
      assert.equal(loaded.module.SAND_OP_LAUNCHER_CODESIGN_REQUIREMENT, undefined);
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

test("inspect without a launcher marks a codesign failure invalid", async () => {
  const loaded = await loadModule("source/electron-main/onepassword/onepassword-cli-runtime.ts", "op-unsigned");
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grok-op-unsigned-"));
    try {
      const opPath = path.join(dir, "op");
      writeFileSync(opPath, "#!/bin/sh\n");
      chmodSync(opPath, 0o755);
      const runtime = darwinRuntime(loaded.module, dir, {
        systemPaths: [opPath],
        runProcess: async (file) => {
          if (file === "/usr/bin/codesign") throw new Error("codesign failed");
          throw new Error("must not read --version of an unsigned op");
        },
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

test("inspect without a launcher marks a bogus --version as invalid", async () => {
  const loaded = await loadModule("source/electron-main/onepassword/onepassword-cli-runtime.ts", "op-invalid");
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grok-op-invalid-"));
    try {
      const opPath = path.join(dir, "op");
      writeFileSync(opPath, "#!/bin/sh\n");
      chmodSync(opPath, 0o755);
      const runtime = darwinRuntime(loaded.module, dir, {
        systemPaths: [opPath],
        runProcess: async (file) => {
          if (file === "/usr/bin/codesign") return { stdout: "", stderr: "" };
          return { stdout: "not-a-version\n", stderr: "" };
        },
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
      const env = {};
      assert.equal(
        loaded.module.resolveWebAuthnSignerPath({ isPackaged: false, repoRoot: dir, env }),
        undefined,
      );
      assert.equal(
        loaded.module.resolveWebAuthnSignerPath({ isPackaged: true, resourcesPath: dir, env }),
        undefined,
      );
      assert.equal(
        loaded.module.resolveWebAuthnSignerPath({
          isPackaged: true,
          resourcesPath: dir,
          env: { SAND_WEBAUTHN_SIGNER_PATH: path.join(dir, "missing-signer") },
        }),
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
  const audit = await readFile(path.join(repoRoot, "scripts/audit-runtime-composition.mjs"), "utf8");
  const packageMacos = await readFile(path.join(repoRoot, "scripts/package-macos.mjs"), "utf8");

  assert.match(asar, /path\.join\(runtimeUnpacked, "deps"\)/);
  assert.doesNotMatch(asar, /path\.join\(runtimeUnpacked, "native"\)/);
  assert.doesNotMatch(asar, /for \(const directory of \["deps", "native"\]\)/);
  assert.match(asar, /await rm\(path\.join\(stageRoot, "dist", "native"\)/);
  assert.doesNotMatch(packageMacos, /runtimeUnpacked.*native|dist\/native\/sand-/);
  assert.match(cleanBuild, /mode: "system-runtime"/);
  assert.match(cleanBuild, /Anysphere Mach-Os from 0\.18 are not copied/);
  assert.doesNotMatch(cleanBuild, /ABI-matched native executables are copied from the checksum-pinned 0\.18 runtime/);
  assert.match(verify, /ASAR still contains dist\/native/);
  assert.match(verify, /walkFiles\(path\.join\(builtAsarUnpacked, "dist", "native"\)\)/);
  assert.doesNotMatch(verify, /sand-op-launcher", "sand-webauthn-signer"/);
  assert.match(bridge, /this\.executor\(opPath, args,/);
  assert.match(bridge, /this\.options\.runtime\.verify\(opPath, signal\)/);
  assert.doesNotMatch(bridge, /resolveVerifiedLauncherPath/);
  assert.doesNotMatch(runtime, /resolveVerifiedLauncherPath|launcherPath|sand-op-launcher|DCNK4UB866/);
  assert.match(runtime, /await this\.verify\(path, signal\)/);
  assert.match(verification, /still contains dist\/native/);
  assert.doesNotMatch(verification, /RUNTIME_ROOTS = \["dist\/deps", "dist\/native"/);
  assert.match(audit, /Missing src\/app\/dist\/deps native runtime inventory/);
  assert.match(audit, /forbidden-unshipped-helper/);
  assert.match(audit, /src\/app\/dist\/native/);
});
