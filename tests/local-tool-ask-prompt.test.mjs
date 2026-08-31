import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadPrompt() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "local-tool-ask-prompt-"));
  const outfile = path.join(temporary, "prompt.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/local-exec/local-tool-ask-prompt.ts")],
    outfile, bundle: true, format: "esm", platform: "node", external: ["electron"],
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const ASK = { id: "req-1", action: "run-command", target: "uname -a", askedAtMs: 1_000, origin: "http://server.test:1447" };

function fakeWindow(answer) {
  const events = {};
  return {
    destroyed: false,
    loaded: null,
    loadURL(url) { this.loaded = url; return Promise.resolve(); },
    once(name, listener) { events[name] = listener; },
    close() { events.closed?.(); },
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; },
    webContents: { executeJavaScript: () => answer },
  };
}

function harness(answer, options = {}) {
  const calls = { approvals: [], answers: [], failures: [] };
  const window = options.window ?? fakeWindow(answer);
  return {
    calls, window,
    deps: {
      readPendingAsks: options.readPendingAsks ?? (() => Promise.resolve([ASK])),
      recordApproval: async (approval) => { calls.approvals.push(approval); },
      answerAsk: async (id, decision) => { calls.answers.push([id, decision]); return true; },
      createWindow: () => window,
      reportFailure: (error) => calls.failures.push(String(error)),
    },
  };
}

test("the question names the exact thing being asked for and who is asking", async () => {
  const { loaded, cleanup } = await loadPrompt();
  try {
    const html = loaded.renderLocalToolAskPrompt(ASK);
    assert.match(html, /uname -a/, "a person cannot consent to an unnamed command");
    assert.match(html, /server\.test:1447/, "and should know where the request came from");
    assert.match(html, /If you do nothing, this is refused/);
    assert.equal(loaded.describeLocalToolAsk({ ...ASK, action: "read-file", target: "~/.ssh/id_rsa" }), "read ~/.ssh/id_rsa");
  } finally { await cleanup(); }
});

test("a command cannot smuggle markup into the question", async () => {
  const { loaded, cleanup } = await loadPrompt();
  try {
    const html = loaded.renderLocalToolAskPrompt({ ...ASK, target: `<img src=x onerror="alert(1)">` });
    assert.doesNotMatch(html, /<img src=x/, "the target is shown as text, never parsed as markup");
    assert.match(html, /&lt;img src=x/);
  } finally { await cleanup(); }
});

test("allow records the approval before it reports the answer", async () => {
  const { loaded, cleanup } = await loadPrompt();
  try {
    const h = harness(Promise.resolve({ decision: "allow" }));
    await loaded.createLocalToolAskWatcher(h.deps).poll();
    assert.deepEqual(h.calls.approvals, [{ id: "req-1", action: "run-command", target: "uname -a" }]);
    assert.deepEqual(h.calls.answers, [["req-1", "allow"]]);
    assert.equal(h.window.isDestroyed(), true, "the window does not outlive the answer");
  } finally { await cleanup(); }
});

test("deny, a closed window, and a broken prompt all refuse and approve nothing", async () => {
  const { loaded, cleanup } = await loadPrompt();
  try {
    const denied = harness(Promise.resolve({ decision: "deny" }));
    await loaded.createLocalToolAskWatcher(denied.deps).poll();
    assert.deepEqual(denied.calls.approvals, []);
    assert.deepEqual(denied.calls.answers, [["req-1", "deny"]]);

    // Closing the window is an answer, and the answer is no.
    let neverAnswered;
    const window = fakeWindow(new Promise((resolve) => { neverAnswered = resolve; }));
    const dismissed = harness(undefined, { window });
    const running = loaded.createLocalToolAskWatcher(dismissed.deps).poll();
    // The watcher registers its closed listener after loading the prompt, so
    // let it get there before the window goes away.
    await new Promise((resolve) => setImmediate(resolve));
    window.close();
    await running;
    neverAnswered({ decision: "deny" });
    assert.deepEqual(dismissed.calls.approvals, []);
    assert.deepEqual(dismissed.calls.answers, [["req-1", "deny"]]);

    const broken = harness(Promise.reject(new Error("prompt died")));
    await loaded.createLocalToolAskWatcher(broken.deps).poll();
    assert.deepEqual(broken.calls.approvals, [], "an answer that could not be collected is not a yes");
    assert.deepEqual(broken.calls.answers, [["req-1", "deny"]]);
  } finally { await cleanup(); }
});

test("only one question is put up at a time, and nothing waiting means no window", async () => {
  const { loaded, cleanup } = await loadPrompt();
  try {
    let release;
    const held = harness(new Promise((resolve) => { release = resolve; }));
    const watcher = loaded.createLocalToolAskWatcher(held.deps);
    const first = watcher.poll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watcher.isPrompting(), true);
    await watcher.poll();
    assert.equal(held.calls.answers.length, 0, "a second poll must not stack another dialog");
    release({ decision: "deny" });
    await first;

    let created = 0;
    // An already-answered question must not be asked twice while the daemon
    // has yet to collect the answer.
    const answered = harness(Promise.resolve({ decision: "allow" }), { readPendingAsks: () => Promise.resolve([{ ...ASK, decision: "allow" }]) });
    answered.deps.createWindow = () => { created += 1; return fakeWindow(Promise.resolve({ decision: "allow" })); };
    await loaded.createLocalToolAskWatcher(answered.deps).poll();
    assert.equal(created, 0, "an answered ask is not re-asked");
    const idle = harness(Promise.resolve({ decision: "allow" }), { readPendingAsks: () => Promise.resolve([]) });
    idle.deps.createWindow = () => { created += 1; return fakeWindow(Promise.resolve({ decision: "allow" })); };
    await loaded.createLocalToolAskWatcher(idle.deps).poll();
    assert.equal(created, 0);
  } finally { await cleanup(); }
});
