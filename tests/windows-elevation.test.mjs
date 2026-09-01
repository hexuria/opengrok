import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry, name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-win-elev-"));
  const outfile = path.join(dir, name);
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile, bundle: true, format: "esm", platform: "node", target: "node22" });
  const mod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { mod, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("only a leading sudo asks for elevation", async () => {
  const { mod, dispose } = await load("source/packages/shell-exec/windows-elevation.ts", "we.mjs");
  try {
    const { commandRequestsElevation: asks } = mod;
    assert.equal(asks("sudo apt install x"), true);
    assert.equal(asks("  sudo whoami"), true);
    assert.equal(asks("sudo"), true);
    assert.equal(asks("echo sudo"), false, "sudo as an argument is not an elevation request");
    assert.equal(asks("sudoedit x"), false, "a different command that starts with the letters is not sudo");
  } finally { dispose(); }
});

test("elevation routes through Windows Sudo inline, or fails with a reason", async () => {
  const { mod, dispose } = await load("source/packages/shell-exec/windows-elevation.ts", "we.mjs");
  try {
    const sudo = "C:\\Windows\\System32\\sudo.exe";
    const ok = mod.planWindowsElevation("sudo whoami", sudo);
    assert.equal(ok.kind, "elevate");
    // --inline is what keeps stdout/stderr flowing back; without it the child
    // opens its own window and the agent sees nothing.
    assert.match(ok.command, /--inline whoami$/);
    assert.ok(ok.command.includes(JSON.stringify(sudo)), "the interpreter path must be quoted");

    // A command that never asked for elevation passes through untouched.
    assert.deepEqual(mod.planWindowsElevation("dir", sudo), { kind: "elevate", command: "dir" });

    const missing = mod.planWindowsElevation("sudo whoami", null);
    assert.equal(missing.kind, "unavailable");
    assert.match(missing.reason, /Enable sudo/);
    assert.equal(mod.planWindowsElevation("sudo   ", sudo).kind, "unavailable");

    assert.match(mod.windowsElevationFailureCommand("nope"), /^Write-Error "nope"; exit 1$/);
  } finally { dispose(); }
});

test("Windows Sudo is found in System32 or on PATH, without a shell", async () => {
  const { mod, dispose } = await load("source/packages/shell-exec/windows-elevation.ts", "we.mjs");
  try {
    const sys = "C:\\Windows\\System32\\sudo.exe";
    assert.equal(mod.findWindowsSudo({ SystemRoot: "C:\\Windows" }, (p) => p === sys), sys);
    assert.equal(
      mod.findWindowsSudo({ SystemRoot: "C:\\Windows", PATH: "C:\\tools" }, (p) => p === "C:\\tools\\sudo.exe"),
      "C:\\tools\\sudo.exe",
    );
    assert.equal(mod.findWindowsSudo({ SystemRoot: "C:\\Windows", PATH: "C:\\tools" }, () => false), null);
    // On a real Windows runner this must answer without throwing, whatever the
    // build ships: Windows Sudo only exists on 11 24H2 and later.
    if (process.platform === "win32") {
      const found = mod.findWindowsSudo();
      assert.ok(found === null || typeof found === "string");
    }
  } finally { dispose(); }
});

test("the shell only elevates when the user's setting allows it", async () => {
  const shell = readFileSync(path.join(repoRoot, "source/packages/shell-exec/powershell.ts"), "utf8");
  assert.match(shell, /process\.platform === "win32" && env\.SAND_ELEVATION_ALLOWED === "1"/);
  assert.match(shell, /planWindowsElevation\(command, findWindowsSudo\(env\)\)/);

  const { mod, dispose } = await load("source/local-exec-daemon/askpass-shell-env.ts", "env.mjs");
  try {
    // Windows carries the gate flag alone; POSIX carries it with the trio.
    assert.deepEqual(mod.askpassShellEnv({ SAND_ELEVATION_ALLOWED: "1" }, "win32"), { SAND_ELEVATION_ALLOWED: "1" });
    assert.equal(mod.askpassShellEnv({}, "win32"), undefined, "no flag means no elevation on Windows");
    const posix = mod.askpassShellEnv(
      { SAND_ASKPASS_HELPER: "/h", SAND_ASKPASS_SOCKET: "/s", SAND_ASKPASS_SECRET: "k" }, "linux",
    );
    assert.equal(posix.SAND_ELEVATION_ALLOWED, "1");
    assert.equal(posix.SUDO_ASKPASS, "/h");
  } finally { dispose(); }
});
