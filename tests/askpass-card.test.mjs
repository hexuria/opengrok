import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

async function loadService() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-askpass-mod-"));
  const outfile = path.join(dir, "askpass-service.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/askpass/askpass-service.ts")],
    outfile, bundle: true, format: "esm", platform: "node", target: "node22",
  });
  const mod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { mod, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

// Speak the wire protocol directly (what the helper does): one JSON line in,
// read the reply, report the outcome.
function askOverSocket(socketPath, payload) {
  return new Promise((resolve) => {
    const connection = net.connect(socketPath);
    let raw = "";
    connection.on("connect", () => connection.write(`${JSON.stringify(payload)}\n`));
    connection.on("data", (chunk) => { raw += chunk.toString("utf8"); });
    connection.on("error", () => resolve({ closed: true, reply: null }));
    connection.on("close", () => {
      let reply = null;
      try { reply = JSON.parse(raw.split("\n")[0] || "null"); } catch {}
      resolve({ closed: reply == null || reply.ok !== true, reply });
    });
  });
}

test("askpass socket round trip: correct secret is prompted and answered", { skip: isWindows }, async () => {
  const { mod, dispose } = await loadService();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-askpass-run-"));
  const service = mod.createAskpassService({ directory: dir, timeoutMs: 5_000 });
  try {
    const prompts = [];
    service.onPrompt((p) => {
      prompts.push(p);
      setTimeout(() => service.resolvePrompt(p.id, "hunter2"), 10);
    });
    const result = await askOverSocket(service.socketPath, { secret: service.secret, prompt: "Password for uriah:" });
    assert.equal(result.reply.ok, true);
    assert.equal(result.reply.password, "hunter2");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].prompt, "Password for uriah:");
    // The env trio names exactly what sudo and shell-core read.
    const env = service.environment();
    assert.equal(env.SAND_ASKPASS_HELPER, service.helperPath);
    assert.equal(env.SAND_ASKPASS_SOCKET, service.socketPath);
    assert.equal(env.SAND_ASKPASS_SECRET, service.secret);
  } finally {
    service.close();
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askpass rejects a wrong secret and denies without a password", { skip: isWindows }, async () => {
  const { mod, dispose } = await loadService();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-askpass-run-"));
  const service = mod.createAskpassService({ directory: dir, timeoutMs: 5_000 });
  try {
    let prompted = false;
    service.onPrompt((p) => { prompted = true; service.resolvePrompt(p.id, null); });

    const wrong = await askOverSocket(service.socketPath, { secret: "not-the-secret", prompt: "x" });
    assert.equal(wrong.closed, true);
    assert.equal(prompted, false, "a bad secret must never raise a card");

    const denied = await askOverSocket(service.socketPath, { secret: service.secret, prompt: "x" });
    assert.equal(denied.closed, true);
    assert.equal(denied.reply.ok, false);
    assert.equal(prompted, true);
  } finally {
    service.close();
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askpass times out into a deny", { skip: isWindows }, async () => {
  const { mod, dispose } = await loadService();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-askpass-run-"));
  const service = mod.createAskpassService({ directory: dir, timeoutMs: 120 });
  try {
    service.onPrompt(() => { /* never answer */ });
    const result = await askOverSocket(service.socketPath, { secret: service.secret, prompt: "x" });
    assert.equal(result.reply.ok, false);
  } finally {
    service.close();
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askpass serializes concurrent prompts one card at a time", { skip: isWindows }, async () => {
  const { mod, dispose } = await loadService();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-askpass-run-"));
  const service = mod.createAskpassService({ directory: dir, timeoutMs: 5_000 });
  try {
    let concurrent = 0, maxConcurrent = 0;
    service.onPrompt((p) => {
      concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
      setTimeout(() => { concurrent -= 1; service.resolvePrompt(p.id, `pw-${p.prompt}`); }, 20);
    });
    const [a, b] = await Promise.all([
      askOverSocket(service.socketPath, { secret: service.secret, prompt: "one" }),
      askOverSocket(service.socketPath, { secret: service.secret, prompt: "two" }),
    ]);
    assert.equal(a.reply.ok, true);
    assert.equal(b.reply.ok, true);
    assert.equal(maxConcurrent, 1, "only one card may be active at once");
  } finally {
    service.close();
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the generated helper pair drives a real fake-sudo through the card", { skip: isWindows }, async () => {
  const { mod, dispose } = await loadService();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-askpass-run-"));
  const service = mod.createAskpassService({ directory: dir, timeoutMs: 5_000 });
  try {
    service.onPrompt((p) => service.resolvePrompt(p.id, "s3cret-pw"));

    // Stand in for sudo -A: exec $SUDO_ASKPASS with a prompt, echo what it reads.
    const fakeSudo = path.join(dir, "fake-sudo.sh");
    writeFileSync(fakeSudo, `#!/bin/sh\nPW="$("$SUDO_ASKPASS" "Password:")" || exit 1\nprintf 'GOT:%s\\n' "$PW"\n`, { mode: 0o755 });
    chmodSync(fakeSudo, 0o755);

    const env = {
      ...process.env,
      SUDO_ASKPASS: service.helperPath,
      CURSOR_ASKPASS_SOCKET: service.socketPath,
      CURSOR_ASKPASS_SECRET: service.secret,
    };
    const stdout = await new Promise((resolve, reject) => {
      execFile("/bin/sh", [fakeSudo], { env, timeout: 10_000 }, (error, out) => (error ? reject(error) : resolve(out)));
    });
    assert.equal(stdout.trim(), "GOT:s3cret-pw");
  } finally {
    service.close();
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the daemon maps SAND_ASKPASS_* onto the sudo/shell env names", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-askpass-env-"));
  const outfile = path.join(dir, "askpass-shell-env.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/local-exec-daemon/askpass-shell-env.ts")],
    outfile, bundle: true, format: "esm", platform: "node", target: "node22",
  });
  const mod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  try {
    const trio = { SAND_ASKPASS_HELPER: "/h/askpass.sh", SAND_ASKPASS_SOCKET: "/h/askpass.sock", SAND_ASKPASS_SECRET: "abc" };
    assert.equal(mod.askpassShellEnv({}, "linux"), undefined, "no trio → no askpass env");
    assert.equal(mod.askpassShellEnv({ SAND_ASKPASS_HELPER: "/h/askpass.sh" }, "linux"), undefined, "a partial trio is ignored");
    assert.deepEqual(mod.askpassShellEnv(trio, "linux"), { SUDO_ASKPASS: "/h/askpass.sh", CURSOR_ASKPASS_SOCKET: "/h/askpass.sock", CURSOR_ASKPASS_SECRET: "abc" });
    assert.deepEqual(mod.askpassShellEnv(trio, "darwin"), { SUDO_ASKPASS: "/h/askpass.sh", CURSOR_ASKPASS_SOCKET: "/h/askpass.sock", CURSOR_ASKPASS_SECRET: "abc" });
    assert.equal(mod.askpassShellEnv(trio, "win32"), undefined, "win32 never wires askpass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the renderer patch wires the askpass card into the helper chain", async () => {
  const src = readFileSync(path.join(repoRoot, "scripts/lib/router-renderer-patch.mjs"), "utf8");
  assert.match(src, /const ASKPASS_CARD_HELPER =/);
  assert.match(src, /LOGIN_PROVIDER_HELPER \+ ASKPASS_CARD_HELPER \+ ACCOUNT_CARD_HELPER/);
  // Password must go straight to respond(), never to storage or the transcript.
  assert.match(src, /api\.respond\(id,/);
  assert.doesNotMatch(src, /localStorage[\s\S]{0,40}sand-ap/);
});

test("the sudo master switch persists off-by-default and round-trips", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-sudo-set-"));
  const outfile = path.join(dir, "sand-settings-store.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts")], outfile, bundle: true, format: "esm", platform: "node", target: "node22" });
  const mod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  try {
    const p = path.join(dir, "settings.json");
    const store = new mod.SandSettingsStore(p);
    assert.equal(store.getSudoAskpassEnabled(), false, "off by default");
    store.setSudoAskpassEnabled(true);
    assert.equal(store.getSudoAskpassEnabled(), true);
    // Survives a fresh instance (i.e. a relaunch) and only accepts real booleans.
    assert.equal(new mod.SandSettingsStore(p).getSudoAskpassEnabled(), true);
    writeFileSync(p, JSON.stringify({ version: 1, sudoAskpassEnabled: "yes" }));
    assert.equal(new mod.SandSettingsStore(p).getSudoAskpassEnabled(), false, "garbage is not truthy");
    store.setSudoAskpassEnabled(false);
    assert.equal(new mod.SandSettingsStore(p).getSudoAskpassEnabled(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the service denies while off and lets exactly one validation prompt through", { skip: isWindows }, async () => {
  const { mod, dispose } = await loadService();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-askpass-gate-"));
  let enabled = false;
  const service = mod.createAskpassService({ directory: dir, timeoutMs: 5_000, isEnabled: () => enabled });
  try {
    const prompts = [];
    service.onPrompt((p) => { prompts.push(p); service.resolvePrompt(p.id, "pw"); });

    // OFF: a correct-secret connection is denied with no card.
    const denied = await askOverSocket(service.socketPath, { secret: service.secret, prompt: "x" });
    assert.equal(denied.closed, true);
    assert.equal(prompts.length, 0, "no card while the feature is off");

    // One-shot validation allowance lets exactly one through, tagged with reason.
    service.allowNextPromptForValidation("Enable administrator commands");
    const validated = await askOverSocket(service.socketPath, { secret: service.secret, prompt: "Password:" });
    assert.equal(validated.reply.ok, true);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].reason, "Enable administrator commands");
    // The allowance was single-use: the next connection is denied again.
    const deniedAgain = await askOverSocket(service.socketPath, { secret: service.secret, prompt: "x" });
    assert.equal(deniedAgain.closed, true);
    assert.equal(prompts.length, 1);

    // ON: prompts flow normally, no reason tag.
    enabled = true;
    const ok = await askOverSocket(service.socketPath, { secret: service.secret, prompt: "Password:" });
    assert.equal(ok.reply.ok, true);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].reason, undefined);
  } finally {
    service.close();
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sudo enable/disable is wired through all three edge places and the toggle", async () => {
  const edge = readFileSync(path.join(repoRoot, "source/electron-main/main-edge.ts"), "utf8");
  const table = readFileSync(path.join(repoRoot, "source/shared/rpc/main.ts"), "utf8");
  const preload = readFileSync(path.join(repoRoot, "source/electron-preload/preload.ts"), "utf8");
  const patch = readFileSync(path.join(repoRoot, "scripts/lib/router-renderer-patch.mjs"), "utf8");
  // Handler + method table + preload — a missing method-table entry is the
  // "mainEdge[method] is not a function" bug, so pin all three.
  assert.match(edge, /getSudoAskpassEnabled:/);
  assert.match(edge, /setSudoAskpassEnabled: async/);
  assert.match(table, /getSudoAskpassEnabled: \{ args: "none" \}/);
  assert.match(table, /setSudoAskpassEnabled: \{ args: "object" \}/);
  assert.match(preload, /sudoAskpass: \{/);
  // Enable is authenticated (not a bare setter) and disable is free.
  assert.match(edge, /authorizeSudoEnable/);
  // The settings toggle reads/writes the new surface and is not optimistic on enable.
  assert.match(patch, /window\.desktop\.sudoAskpass\.set\(!0\)/);
  assert.match(patch, /Allow administrator \(sudo\) commands/);
});
