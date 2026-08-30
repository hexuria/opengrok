import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry, outfileName) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-subscription-cli-auth-"));
  const output = path.join(temporary, outfileName);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function status(provider, authenticated, extra = {}) {
  return {
    provider,
    installed: extra.installed ?? true,
    authenticated,
    executablePath: extra.executablePath ?? (provider === "codex" ? "/bin/codex" : "/bin/claude"),
    loginCommand: extra.loginCommand ?? (provider === "codex" ? ["codex", "login"] : ["claude", "/login"]),
    prompt: extra.prompt ?? (authenticated ? "signed in" : `${provider} is not signed in.`),
  };
}

test("Claude auth status --json reports signed-in and fails closed otherwise", async () => {
  const loaded = await loadModule("source/shared/node/subscription-cli-auth.ts", "subscription-cli-auth.mjs");
  try {
    const { parseClaudeAuthStatusJson, CLAUDE_AUTH_STATUS_ARGS } = loaded.module;
    assert.deepEqual([...CLAUDE_AUTH_STATUS_ARGS], ["auth", "status", "--json"]);
    assert.equal(parseClaudeAuthStatusJson('{"loggedIn":true}'), true);
    assert.equal(parseClaudeAuthStatusJson('{"loggedIn":false,"authMethod":"none"}'), false);
    assert.equal(parseClaudeAuthStatusJson("", '{"loggedIn":true}'), true);
    assert.equal(parseClaudeAuthStatusJson("not json"), false);
    assert.equal(parseClaudeAuthStatusJson(""), false);
  } finally {
    await loaded.dispose();
  }
});

test("Codex login status treats official CLI text as the source of truth", async () => {
  const loaded = await loadModule("source/shared/node/subscription-cli-auth.ts", "subscription-cli-auth.mjs");
  try {
    const { parseCodexLoginStatusText, CODEX_LOGIN_STATUS_ARGS } = loaded.module;
    assert.deepEqual([...CODEX_LOGIN_STATUS_ARGS], ["login", "status"]);
    assert.equal(parseCodexLoginStatusText("Logged in as user@example.com"), true);
    assert.equal(parseCodexLoginStatusText("", "logged in using chatgpt"), true);
    assert.equal(parseCodexLoginStatusText("Not logged in"), false);
    assert.equal(parseCodexLoginStatusText(""), false);
  } finally {
    await loaded.dispose();
  }
});

test("Codex Settings treats a usable auth.json as signed in even if CLI status lags", async () => {
  const loaded = await loadModule("source/shared/node/subscription-cli-auth.ts", "subscription-cli-auth.mjs");
  try {
    const port = loaded.module.createSubscriptionCliAuthPort({
      platform: "linux",
      resolveCodexPath: () => "/bin/codex",
      fileCodexAuthenticated: () => true,
      runCli: async () => ({ ok: false, stdout: "Not logged in", stderr: "" }),
    });
    const status = await port.getStatus("codex");
    assert.equal(status.authenticated, true);
    assert.match(status.prompt, /Signed in with the official Codex/);
  } finally {
    await loaded.dispose();
  }
});

test("official logout uses claude /logout and codex logout", async () => {
  const loaded = await loadModule("source/shared/node/subscription-cli-auth.ts", "subscription-cli-auth.mjs");
  try {
    const { CLAUDE_SUBSCRIPTION_LOGOUT_ARGS, CODEX_SUBSCRIPTION_LOGOUT_ARGS, subscriptionLogoutArgs } = loaded.module;
    assert.deepEqual([...CLAUDE_SUBSCRIPTION_LOGOUT_ARGS], ["/logout"]);
    assert.deepEqual([...CODEX_SUBSCRIPTION_LOGOUT_ARGS], ["logout"]);
    assert.deepEqual([...subscriptionLogoutArgs("claude-code")], ["/logout"]);
    assert.deepEqual([...subscriptionLogoutArgs("codex")], ["logout"]);

    const runs = [];
    const signedIn = { claude: true, codex: true };
    const port = loaded.module.createSubscriptionCliAuthPort({
      platform: "linux",
      env: { PATH: "/custom/bin", OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "ant-test" },
      resolveClaudePath: () => "/bin/claude",
      resolveCodexPath: () => "/bin/codex",
      fileCodexAuthenticated: () => false,
      runCli: async (file, args, options) => {
        runs.push({ file, args, env: options.env });
        const kind = file.includes("claude") ? "claude" : "codex";
        if (args.includes("logout") || args.includes("/logout")) {
          signedIn[kind] = false;
          return { ok: true, stdout: kind === "claude" ? '{"loggedIn":false}' : "Not logged in", stderr: "" };
        }
        return {
          ok: true,
          stdout: kind === "claude"
            ? (signedIn.claude ? '{"loggedIn":true}' : '{"loggedIn":false}')
            : (signedIn.codex ? "Logged in as user@example.com" : "Not logged in"),
          stderr: "",
        };
      },
    });
    const claude = await port.logout("claude-code");
    const codex = await port.logout("codex");
    assert.equal(claude.loggedOut, true);
    assert.equal(codex.loggedOut, true);
    const claudeLogout = runs.find((run) => run.file === "/bin/claude" && run.args.includes("/logout"));
    const codexLogout = runs.find((run) => run.file === "/bin/codex" && run.args.includes("logout") && !run.args.includes("status"));
    assert.ok(claudeLogout);
    assert.ok(codexLogout);
    assert.equal(claudeLogout.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(codexLogout.env.OPENAI_API_KEY, undefined);
  } finally {
    await loaded.dispose();
  }
});

test("login command wiring uses official CLI args and drops API keys", async () => {
  const loaded = await loadModule("source/shared/node/subscription-cli-auth.ts", "subscription-cli-auth.mjs");
  try {
    const runs = [];
    const port = loaded.module.createSubscriptionCliAuthPort({
      platform: "linux",
      env: { PATH: "/custom/bin", OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "ant-test", HOME: "/tmp" },
      resolveClaudePath: () => "/bin/claude",
      resolveCodexPath: () => "/bin/codex",
      fileCodexAuthenticated: () => false,
      runCli: async (file, args, options) => {
        runs.push({ kind: "status", file, args, env: options.env });
        return { ok: false, stdout: file.includes("claude") ? '{"loggedIn":false}' : "Not logged in", stderr: "" };
      },
      startLogin: async (file, args, options) => {
        runs.push({ kind: "login", file, args, env: options.env });
        return { started: true };
      },
    });

    const claude = await port.startLogin("claude-code");
    const codex = await port.startLogin("codex");
    assert.equal(claude.started, true);
    assert.equal(codex.started, true);
    assert.equal(claude.status.authenticated, false);
    assert.equal(codex.status.authenticated, false);

    const claudeLogin = runs.find((run) => run.kind === "login" && run.file === "/bin/claude");
    const codexLogin = runs.find((run) => run.kind === "login" && run.file === "/bin/codex");
    const claudeStatus = runs.find((run) => run.kind === "status" && run.file === "/bin/claude");
    const codexStatus = runs.find((run) => run.kind === "status" && run.file === "/bin/codex");
    assert.deepEqual([...claudeLogin.args], ["/login"]);
    assert.deepEqual([...codexLogin.args], ["login"]);
    assert.deepEqual([...claudeStatus.args], ["auth", "status", "--json"]);
    assert.deepEqual([...codexStatus.args], ["login", "status"]);
    assert.equal(claudeLogin.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(claudeStatus.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(codexLogin.env.OPENAI_API_KEY, undefined);
    assert.equal(codexStatus.env.OPENAI_API_KEY, undefined);
    assert.match(claude.status.prompt, /claude \/login/);
    assert.match(codex.status.prompt, /browser tab/);
  } finally {
    await loaded.dispose();
  }
});

test("codex login runs in the background and a missing CLI opens the install terminal", async () => {
  const loaded = await loadModule("source/shared/node/subscription-cli-auth.ts", "subscription-cli-auth.mjs");
  try {
    const logins = [];
    const installOpens = [];
    const auth = loaded.module.createSubscriptionCliAuthPort({
      platform: "darwin",
      resolveClaudePath: () => "/bin/claude",
      resolveCodexPath: () => "/bin/codex",
      fileCodexAuthenticated: () => false,
      runCli: async () => ({ ok: true, stdout: "logged out", stderr: "" }),
      startLogin: async (file, args, options) => { logins.push({ file, args: [...args], mode: options.mode }); return { started: true }; },
      openInstallTerminal: async (options) => { installOpens.push(options); return { opened: true }; },
    });
    const codex = await auth.startLogin("codex");
    assert.equal(logins.at(-1).mode, "background");
    assert.equal(codex.started, true);
    await auth.startLogin("claude-code");
    assert.equal(logins.at(-1).mode, "terminal");
    assert.equal(installOpens.length, 0);

    const missing = loaded.module.createSubscriptionCliAuthPort({
      platform: "darwin",
      resolveClaudePath: () => null,
      resolveCodexPath: () => null,
      fileCodexAuthenticated: () => false,
      runCli: async () => ({ ok: true, stdout: "", stderr: "" }),
      startLogin: async () => { throw new Error("should not start login without a CLI"); },
      openInstallTerminal: async (options) => { installOpens.push(options); return { opened: true }; },
    });
    const result = await missing.startLogin("codex");
    assert.equal(result.started, false);
    assert.equal(installOpens.length, 1);
    assert.match(result.status.prompt, /curl -fsSL https:\/\/chatgpt\.com\/codex\/install\.sh \| sh/);
    assert.equal(loaded.module.codexInstallCommand("win32").includes("install.ps1"), true);
  } finally {
    await loaded.dispose();
  }
});

test("provider switch persists Claude or Codex before official login", async () => {
  const loaded = await loadModule("source/shared/node/subscription-cli-auth.ts", "subscription-cli-auth.mjs");
  try {
    const logins = [];
    const auth = loaded.module.createSubscriptionCliAuthPort({
      platform: "linux",
      resolveClaudePath: () => "/bin/claude",
      resolveCodexPath: () => "/bin/codex",
      fileCodexAuthenticated: () => false,
      runCli: async () => ({ ok: false, stdout: '{"loggedIn":false}', stderr: "Not logged in" }),
      startLogin: async (file, args) => {
        logins.push({ file, args });
        return { started: true };
      },
    });
    const claude = await loaded.module.selectSubscriptionInferenceProvider({
      requested: "claude-code",
      current: "cursor",
      auth,
    });
    const codex = await loaded.module.selectSubscriptionInferenceProvider({
      requested: "codex",
      current: "cursor",
      auth,
    });
    assert.equal(claude.ok, true);
    assert.equal(claude.provider, "claude-code");
    assert.equal(claude.loginStarted, false);
    assert.equal(codex.ok, true);
    assert.equal(codex.provider, "codex");
    assert.equal(codex.loginStarted, false);
    assert.equal(logins.length, 0);
  } finally {
    await loaded.dispose();
  }
});

test("provider switch succeeds when official CLI status is signed-in and Cursor stays untouched", async () => {
  const loaded = await loadModule("source/shared/node/subscription-cli-auth.ts", "subscription-cli-auth.mjs");
  try {
    let logins = 0;
    const auth = {
      async getStatus(provider) {
        return status(provider, true, { prompt: provider === "codex" ? "Signed in with the official Codex/ChatGPT subscription." : "Signed in with the official Claude Pro/Max subscription." });
      },
      async startLogin() {
        logins += 1;
        throw new Error("already signed in");
      },
    };
    const claude = await loaded.module.selectSubscriptionInferenceProvider({ requested: "claude-code", current: "cursor", auth });
    const codex = await loaded.module.selectSubscriptionInferenceProvider({ requested: "codex", current: "cursor", auth });
    const cursor = await loaded.module.selectSubscriptionInferenceProvider({ requested: "cursor", current: "claude-code", auth });
    const openrouter = await loaded.module.selectSubscriptionInferenceProvider({ requested: "openrouter", current: "cursor", auth });
    assert.deepEqual({ ok: claude.ok, provider: claude.provider }, { ok: true, provider: "claude-code" });
    assert.deepEqual({ ok: codex.ok, provider: codex.provider }, { ok: true, provider: "codex" });
    assert.deepEqual({ ok: cursor.ok, provider: cursor.provider }, { ok: true, provider: "cursor" });
    assert.deepEqual({ ok: openrouter.ok, provider: openrouter.provider }, { ok: true, provider: "openrouter" });
    assert.equal(logins, 0);
    assert.match(claude.local["claude-code"].prompt, /Signed in/);
  } finally {
    await loaded.dispose();
  }
});

test("main-edge persists Claude before official login and Skip records the login-wall bypass", async () => {
  const loaded = await loadModule("source/electron-main/main-edge.ts", "main-edge.mjs");
  try {
    let provider = "cursor";
    let loginWallSkipped = false;
    let logins = 0;
    const auth = {
      async getStatus(id) {
        return status(id, false);
      },
      async startLogin(id) {
        logins += 1;
        return { started: true, status: status(id, false, { prompt: `${id} is not signed in. Run official login.` }) };
      },
    };
    const handlers = loaded.module.createMainEdgeHandlers({
      settingsStore: {
        getInferenceProvider: () => provider,
        setInferenceProvider: (value) => { provider = value; },
        getInferenceRouterUsage: () => null,
        getCursorLoginWallSkipped: () => loginWallSkipped,
        setCursorLoginWallSkipped: (value) => { loginWallSkipped = value === true; },
      },
      readHostSettingsFromBox: async () => ({}),
      syncHostSettingsToBox: async (settings) => settings,
      subscriptionAuth: auth,
    });
    const current = await handlers.getInferenceRouter();
    assert.equal(current.provider, "cursor");
    assert.equal(current.loginWallSkipped, false);
    await handlers.setInferenceRouter({ provider: "cursor" });
    assert.equal(provider, "cursor");
    const switched = await handlers.setInferenceRouter({ provider: "claude-code" });
    assert.equal(switched.provider, "claude-code");
    assert.equal(provider, "claude-code");
    assert.equal(logins, 0);
    const skipped = await handlers.skipCursorLoginWall({ provider: "codex" });
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.provider, "codex");
    assert.equal(loginWallSkipped, true);
    assert.equal(provider, "codex");
    const afterSkip = await handlers.getInferenceRouter();
    assert.equal(afterSkip.loginWallSkipped, true);
    const started = await handlers.startSubscriptionLogin({ provider: "codex" });
    assert.equal(started.started, true);
    assert.equal(logins, 1);
  } finally {
    await loaded.dispose();
  }
});

test("coordinator sendPrompt fail-closed when Claude or Codex is unauthenticated", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/inference-router.ts", "inference-router.mjs");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-router-auth-"));
  try {
    await writeFile(path.join(temporary, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "claude-code" }));
    const remoteCalls = [];
    let sawPrompt;
    const sawError = new Promise((resolve) => { sawPrompt = resolve; });
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent(family, payload) {
        const content = payload?.entry?.message?.content;
        if (family === "transcript" && typeof content === "string" && content.includes("not signed in")) sawPrompt(content);
      },
      async dispatchRemote(method) {
        remoteCalls.push(method);
        return { entries: [] };
      },
      subscriptionAuth: {
        async getStatus(id) { return status(id, false, { prompt: `${id} is not signed in.` }); },
        async startLogin() { throw new Error("sendPrompt must not start login"); },
      },
    });
    const dispatched = await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hello", clientNonce: "n1" });
    assert.equal(dispatched.handled, true);
    const content = await Promise.race([
      sawError,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for fail-closed transcript")), 2_000)),
    ]);
    assert.match(content, /not signed in/);
    assert.equal(remoteCalls.includes("listRoutedMcpTools"), false);
    assert.equal(remoteCalls.includes("getAgentTranscriptTail"), false);
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("coordinator Cursor path is unchanged and does not consult Claude/Codex login", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/inference-router.ts", "inference-router.mjs");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-router-cursor-"));
  try {
    await writeFile(path.join(temporary, "settings.json"), JSON.stringify({ inferenceProvider: "cursor" }));
    let statusReads = 0;
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent() {},
      async dispatchRemote() { return { entries: [] }; },
      subscriptionAuth: {
        async getStatus() { statusReads += 1; return status("claude-code", false); },
        async startLogin() { throw new Error("cursor path must not login"); },
      },
    });
    const dispatched = await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hello" });
    assert.equal(dispatched.handled, false);
    assert.equal(statusReads, 0);
  } finally {
    await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
