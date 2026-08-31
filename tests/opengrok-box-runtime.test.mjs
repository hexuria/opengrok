import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadBoxRuntime() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-box-runtime-"));
  const outfile = path.join(temporary, "box-runtime.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/box-runtime.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

test("the OpenGrok server is a real runtime, offered to every provider", async () => {
  const { loaded, cleanup } = await loadBoxRuntime();
  try {
    assert.equal(loaded.isSandBoxRuntime("opengrok"), true);
    assert.ok(loaded.SAND_BOX_RUNTIME_OPTIONS.some((o) => o.value === "opengrok"));
    // Choosing it is what makes the router provider moot, so no provider may gate
    // it and none may coerce it away - either would silently drop the user's server.
    for (const provider of ["cursor", "codex", "openrouter", "claude-code"]) {
      assert.equal(loaded.boxRuntimeAllowedForProvider("opengrok", provider), true, provider);
      assert.equal(loaded.coerceBoxRuntimeForProvider("opengrok", provider), "opengrok", provider);
    }
    assert.equal(loaded.boxRuntimeOwnsInference("opengrok"), true);
    assert.equal(loaded.boxRuntimeOwnsInference("local-docker"), false);
    // The existing runtimes must keep their behaviour.
    assert.equal(loaded.coerceBoxRuntimeForProvider("remote", "codex"), "local-docker");
    assert.equal(loaded.coerceBoxRuntimeForProvider("remote", "cursor"), "remote");
  } finally {
    await cleanup();
  }
});

test("the bearer has a secret-store key, not a settings field", async () => {
  const { loaded, cleanup } = await loadBoxRuntime();
  try {
    assert.equal(loaded.OPENGROK_GATEWAY_TOKEN_SECRET, "opengrok-gateway-token");
  } finally {
    await cleanup();
  }
});

test("the server URL survives a settings round-trip", async () => {
  // It did not, at first: parseSettings drops unknown keys on load, so the write
  // landed and the next read threw it away. hasToken said true while gatewayUrl
  // said null - the shape of that bug.
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-settings-"));
  try {
    const outfile = path.join(temporary, "settings-store.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts")],
      outfile, bundle: true, format: "esm", platform: "node",
    });
    const { SandSettingsStore } = await import(pathToFileURL(outfile).href);
    const settingsPath = path.join(temporary, "settings.json");
    const store = new SandSettingsStore(settingsPath);
    store.setOpenGrokGatewayUrl("http://192.168.1.10:1447");
    assert.equal(new SandSettingsStore(settingsPath).getOpenGrokGatewayUrl(), "http://192.168.1.10:1447");
    store.setOpenGrokGatewayUrl(undefined);
    assert.equal(new SandSettingsStore(settingsPath).getOpenGrokGatewayUrl(), undefined);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the account backend follows the configured server, and falls back to env", async () => {
  // One account, not two. Whoever answers this URL is who the app's account
  // belongs to - that is what makes an OpenGrok server a drop-in rather than a
  // second identity sitting beside the Cursor one.
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-backend-"));
  try {
    const outfile = path.join(temporary, "cursor-token.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/shared/node/cursor-token.ts")],
      outfile, bundle: true, format: "esm", platform: "node",
    });
    const { getConfiguredBackendUrl, setBackendUrlResolver } = await import(pathToFileURL(outfile).href);

    const env = { SAND_BACKEND_URL: "https://backend.example/" };
    assert.equal(getConfiguredBackendUrl(env), "https://backend.example/");

    setBackendUrlResolver(() => "http://192.168.1.10:1447");
    assert.equal(getConfiguredBackendUrl(env), "http://192.168.1.10:1447/");

    // No server configured: the env answer stands.
    setBackendUrlResolver(() => undefined);
    assert.equal(getConfiguredBackendUrl(env), "https://backend.example/");

    // A resolver that throws must not take the account down with it.
    setBackendUrlResolver(() => { throw new Error("settings unreadable"); });
    assert.equal(getConfiguredBackendUrl(env), "https://backend.example/");

    setBackendUrlResolver(null);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function loadSignIn() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-signin-"));
  const outfile = path.join(temporary, "signin.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/box/opengrok-signin.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["electron"],
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// The parser names the fields it keeps, so a field it does not name is dropped
// in silence. That is how "configured" went missing: the server sent it, the
// panel never saw it, and a box the organisation had never set up rendered as
// ready to use. Pin the whole row against the payload the server actually sends.
test("a computer the organisation has not configured stays marked unconfigured", async () => {
  const { loaded, cleanup } = await loadSignIn();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    computers: [
      { id: "local-docker", label: "Local VM (on the server)", kind: "local-docker", state: "available", configured: true, active: true },
      { id: "ascii", label: "box.ascii.dev", kind: "ascii", state: "not-configured", configured: false },
      { id: "windows365", label: "Windows 365", kind: "windows365", state: "not-configured", configured: false },
    ],
    activeKind: "local-docker",
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const { computers: rows } = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.configured), [true, false, false]);
    assert.deepEqual(rows.map((row) => row.label), ["Local VM (on the server)", "box.ascii.dev", "Windows 365"]);
    assert.deepEqual(rows.map((row) => row.kind), ["local-docker", "ascii", "windows365"]);
    assert.deepEqual(rows.map((row) => row.active), [true, undefined, undefined], "the account's own computer must be identifiable");
  } finally {
    globalThis.fetch = realFetch;
    await cleanup();
  }
});

// A server that says nothing about configuration is not asserting the computer
// is unusable, so absence must stay absent rather than becoming false.
test("a server that omits configured leaves it unset rather than guessing", async () => {
  const { loaded, cleanup } = await loadSignIn();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    computers: [{ id: "only", label: "Only", kind: "local-docker", state: "available" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const { computers: rows } = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.equal(rows.length, 1);
    assert.ok(!("configured" in rows[0]));
  } finally {
    globalThis.fetch = realFetch;
    await cleanup();
  }
});

// The coordinator asks which backend owns the session on every renderer request,
// and the answer used to cost a read, a parse and a migration pass each time.
// It is cached now, which is only safe if a change to the file still lands: a
// stale answer here routes the roster to the wrong backend and the app looks
// connected while showing someone else's bots.
test("the cached box runtime still follows a change to settings.json", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-runtime-cache-"));
  try {
    const bundle = async (entry, name) => {
      const outfile = path.join(temporary, name);
      await build({
        entryPoints: [path.join(repoRoot, entry)],
        outfile, bundle: true, format: "esm", platform: "node",
        external: ["electron"], logLevel: "silent",
      });
      return await import(pathToFileURL(outfile).href);
    };
    const { readBoxRuntime } = await bundle("source/node-agent-coordinator/main.ts", "coordinator.mjs");
    // Written through the store rather than by hand, so the test cannot drift
    // from the on-disk schema the way a literal would.
    const { SandSettingsStore } = await bundle("source/shared/node/settings/sand-settings-store.ts", "store.mjs");

    const dataDir = path.join(temporary, "data");
    const store = new SandSettingsStore(path.join(dataDir, "settings.json"));

    store.setBoxRuntime("opengrok");
    assert.equal(readBoxRuntime(dataDir), "opengrok");
    assert.equal(readBoxRuntime(dataDir), "opengrok", "an unchanged file must keep answering the same way");

    store.setBoxRuntime("local-docker");
    assert.equal(readBoxRuntime(dataDir), "local-docker", "a rewritten file must invalidate the cached answer");

    store.setBoxRuntime("opengrok");
    assert.equal(readBoxRuntime(dataDir), "opengrok", "and again, in the other direction");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// The code is the contract and the message is prose the server may reword, so
// an unrecognised code must survive verbatim rather than being flattened - a
// code we do not know yet still carries a message worth showing.
test("a provisioning failure reaches the client with its code and its words", async () => {
  const { loaded, cleanup } = await loadSignIn();
  const realFetch = globalThis.fetch;
  const reply = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  try {
    globalThis.fetch = reply({
      computers: [],
      computerError: { code: "no_org_key", message: "no computer is configured for your organization" },
    });
    const failed = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.deepEqual(failed.computers, []);
    assert.equal(failed.computerError.code, "no_org_key");
    assert.match(failed.computerError.message, /no computer is configured/);

    globalThis.fetch = reply({ computers: [{ id: "local-docker", label: "Local VM", kind: "local-docker" }], computerError: null });
    const fine = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.equal(fine.computerError, null, "a provisioned computer must clear the error to null");
    assert.equal(fine.computers.length, 1);

    globalThis.fetch = reply({ computers: [], computerError: { code: "a_code_from_a_later_server", message: "something new" } });
    const future = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.equal(future.computerError.code, "a_code_from_a_later_server", "an unknown code must not be rewritten");
    assert.equal(future.computerError.message, "something new");

    globalThis.fetch = reply({ computers: [], computerError: { message: "no code at all" } });
    const codeless = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.equal(codeless.computerError.code, "unknown", "a missing code falls back rather than throwing away the message");
    assert.equal(codeless.computerError.message, "no code at all");

    globalThis.fetch = reply({ computers: [] });
    const silent = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.equal(silent.computerError, null, "a server that says nothing has not reported a failure");
  } finally {
    globalThis.fetch = realFetch;
    await cleanup();
  }
});

// The gateway bearer says which gateway may be talked to; it is shared, so on
// its own the server can only guess whose account a call is for. The account
// header names the caller. It must reach our own server and nowhere else: a
// Cursor gateway has no use for it and must never be handed an account token it
// did not ask for.
test("the account header is sent to our own server and to no one else", async () => {
  const temporary = await mkdtemp(path.join(repoRoot, ".tmp-account-header-"));
  try {
    // One entry re-exporting both, so the resolver the test sets is the very one
    // the connector reads — two separate bundles would each carry their own.
    const entry = path.join(temporary, "entry.ts");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(entry, [
      `export * from ${JSON.stringify(path.join(repoRoot, "source/electron-main/box/box-host-connector.ts"))};`,
      `export { setBackendUrlResolver } from ${JSON.stringify(path.join(repoRoot, "source/shared/node/cursor-token.ts"))};`,
    ].join("\n"), "utf8");

    const outfile = path.join(temporary, "connector.mjs");
    await build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const mod = await import(pathToFileURL(outfile).href);

    assert.equal(mod.OPENGROK_ACCOUNT_HEADER, "x-opengrok-account");
    const client = { ensureSandBox: async () => ({ gatewayUrl: "http://server.test:1447", gatewayToken: "gw", networkToken: "", vncUrl: "", forkVncBaseUrl: "" }) };
    const deps = { getAccessToken: async () => "account-jwt" };

    mod.setBackendUrlResolver(() => "http://server.test:1447");
    const mine = await new mod.BrokeredHostConnector(deps, client).connect();
    assert.equal(mine.headers?.[mod.OPENGROK_ACCOUNT_HEADER], "account-jwt");

    mod.setBackendUrlResolver(() => "https://api2.cursor.sh");
    const theirs = await new mod.BrokeredHostConnector(deps, client).connect();
    assert.equal(theirs.headers?.[mod.OPENGROK_ACCOUNT_HEADER], undefined,
      "an account token must never be sent to a gateway that is not ours");

    // A token we cannot get is not a reason to refuse the call: without the
    // header the server falls back, which is how it behaved before this existed.
    mod.setBackendUrlResolver(() => "http://server.test:1447");
    const noToken = await new mod.BrokeredHostConnector({ getAccessToken: async () => { throw new Error("no token"); } }, client).connect();
    assert.equal(noToken.headers?.[mod.OPENGROK_ACCOUNT_HEADER], undefined);
    assert.equal(noToken.baseUrl, "http://server.test:1447", "the connection still stands without the header");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// Someone signing in to their own server was told "Grok Bot couldn't confirm
// your Cursor sign-in" — naming a product they were not using and an account
// they had never had. The wording must follow the backend actually configured,
// and it is read at use time because that backend changes while the app runs.
test("a signed-out message names the backend the person actually used", async () => {
  const temporary = await mkdtemp(path.join(repoRoot, ".tmp-signin-msg-"));
  try {
    const entry = path.join(temporary, "entry.ts");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(entry, [
      `export { SandCursorAuthService } from ${JSON.stringify(path.join(repoRoot, "source/electron-main/account/cursor-auth.ts"))};`,
      `export { setBackendUrlResolver, DEFAULT_CURSOR_BACKEND_URL } from ${JSON.stringify(path.join(repoRoot, "source/shared/node/cursor-token.ts"))};`,
    ].join("\n"), "utf8");
    const outfile = path.join(temporary, "auth.mjs");
    await build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const mod = await import(pathToFileURL(outfile).href);

    const source = await readFile(path.join(repoRoot, "source/electron-main/account/cursor-auth.ts"), "utf8");
    // No signed-out message may hard-code one backend's wording any more.
    for (const [, line] of source.matchAll(/^const [A-Z_]+_STATUS = \{ kind: "logged-out", errorMessage: "([^"]+)"/gm)) {
      assert.fail(`a signed-out message is still fixed to one backend: ${line}`);
    }
    assert.match(source, /function loggedOut\(cursorText: string, openGrokText: string\)/);
    // Read at use time, not at module load, or the wording freezes at startup.
    assert.match(source, /get errorMessage\(\): string/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// Signing somebody out is the most destructive thing this service does, and it
// used to happen for ANY non-2xx: a server answering 502 for one second while
// it restarted ended the session and made the person sign in again. A server
// that was fully down never did that, so a restarting backend was treated more
// harshly than an absent one.
async function loadAuth(temporaryRoot) {
  const outfile = path.join(temporaryRoot, "auth.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/account/cursor-auth.ts")],
    outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent",
  });
  return await import(pathToFileURL(outfile).href);
}

function fakeSecrets(initial) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    readSecret: async (k) => store.get(k) ?? null,
    writeSecret: async (k, v) => { store.set(k, v); },
    deleteSecret: async (k) => { store.delete(k); },
  };
}

test("a backend that cannot answer does not end the session", async () => {
  const temporary = await mkdtemp(path.join(repoRoot, ".tmp-refresh-"));
  try {
    const mod = await loadAuth(temporary);
    const reply = (status, body) => new Response(body == null ? "" : JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });

    for (const [status, body] of [[503, { error: "database unavailable" }], [500, null], [502, null], [429, null]]) {
      const secrets = fakeSecrets({ "cursor-access-token": "access", "cursor-refresh-token": "refresh" });
      const service = new mod.SandCursorAuthService({ secrets, fetchOAuthToken: async () => reply(status, body) });
      await assert.rejects(
        () => service.getValidAccessToken({ backendUrl: "http://server.test:1447" }),
        (error) => error instanceof mod.SandAuthRefreshUnavailableError,
        `HTTP ${status} must not be treated as a rejected credential`,
      );
      // The credentials survive: the next attempt can succeed without a sign-in.
      assert.equal(secrets.store.get("cursor-refresh-token"), "refresh", `HTTP ${status} must keep the refresh token`);
      assert.equal(secrets.store.get("cursor-access-token"), "access", `HTTP ${status} must keep the access token`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// The backend states a rejection: 401 with shouldLogout. That, and only that,
// ends a session.
test("a rejected credential does end the session", async () => {
  const temporary = await mkdtemp(path.join(repoRoot, ".tmp-refresh-reject-"));
  try {
    const mod = await loadAuth(temporary);
    const secrets = fakeSecrets({ "cursor-access-token": "access", "cursor-refresh-token": "refresh" });
    const service = new mod.SandCursorAuthService({
      secrets,
      fetchOAuthToken: async () => new Response(JSON.stringify({ error: "unknown refresh token", shouldLogout: true }), {
        status: 401, headers: { "content-type": "application/json" },
      }),
    });
    await assert.rejects(
      () => service.getValidAccessToken({ backendUrl: "http://server.test:1447" }),
      (error) => error instanceof mod.SandAuthSignInExpiredError,
      "a stated rejection must end the session",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// Refresh tokens rotate single-use, so two refreshes racing leave the loser
// presenting a token the backend has already replaced. It answers exactly as it
// would for a dead session, so the only way to tell them apart is that our own
// store has moved on — and signing the person out there would be wrong.
test("losing a rotation race is not a reason to sign anybody out", async () => {
  const temporary = await mkdtemp(path.join(repoRoot, ".tmp-refresh-race-"));
  try {
    const mod = await loadAuth(temporary);
    const secrets = fakeSecrets({ "cursor-access-token": "stale-access", "cursor-refresh-token": "token-we-present" });
    const service = new mod.SandCursorAuthService({
      secrets,
      // The other refresh wins while ours is in flight: it stores its new pair,
      // and the backend then rejects the token we presented as unknown.
      fetchOAuthToken: async () => {
        secrets.store.set("cursor-refresh-token", "token-the-winner-stored");
        secrets.store.set("cursor-access-token", "access-the-winner-stored");
        return new Response(JSON.stringify({ error: "unknown refresh token", shouldLogout: true }), {
          status: 401, headers: { "content-type": "application/json" },
        });
      },
    });
    const token = await service.getValidAccessToken({ backendUrl: "http://server.test:1447" });
    assert.equal(token, "access-the-winner-stored", "the winner's token must be used instead of signing out");
    assert.equal(secrets.store.get("cursor-refresh-token"), "token-the-winner-stored", "the session must survive intact");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// One spinner used to stand for every state a computer could be in: coming up,
// asleep, never created, and killed by the host. Worst of all, a box that was
// running perfectly but headless — the normal case for a server-side box doing
// shell and file work — said "Booting up the computer" forever, because the
// placeholder exists to fill the space where a screen would be and had nothing
// to draw.
test("the computer placeholder says what is actually true of the box", async () => {
  const src = await readFile(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs"), "utf8");
  const chrome = eval(/export const MAIN_CHROME_SOURCE = ([\s\S]*?);\n\n/.exec(src)[1]);
  const RBoxEmptyMessage = new Function(`${chrome}\nreturn RBoxEmptyMessage;`)();

  const known = (state) => RBoxEmptyMessage({ isStatusKnown: true, isStatusUnavailable: false, status: { state } });

  // Running with no screen is the case that used to lie outright.
  assert.match(known("running"), /no screen/i);
  // Asleep is recoverable, and the way to recover it is worth saying.
  assert.match(known("stopped"), /asleep/i);
  assert.match(known("stopped"), /message/i);
  assert.match(known("absent"), /no computer/i);
  // A provider word we have never seen is still reported rather than swallowed.
  assert.match(known("exited"), /exited/);

  // Only a genuinely unknown status keeps the original wording, because there
  // the app really is still finding out.
  assert.equal(RBoxEmptyMessage({ isStatusKnown: false, isStatusUnavailable: false, status: null }), undefined);
  // An unreachable status has its own message and its own retry; leave it alone.
  assert.equal(RBoxEmptyMessage({ isStatusKnown: true, isStatusUnavailable: true, status: { state: "running" } }), undefined);
  assert.equal(RBoxEmptyMessage(null), undefined);
  assert.equal(RBoxEmptyMessage({ isStatusKnown: true, isStatusUnavailable: false, status: {} }), undefined);
});

// The panel lists what the organisation offers and cannot pick between them, so
// it has to say which one is actually in use — otherwise it reads as a chooser
// nobody can operate. Both forms the server sends must survive the parser.
test("the account's own computer is named, by row flag or by kind", async () => {
  const { loaded, cleanup } = await loadSignIn();
  const realFetch = globalThis.fetch;
  const reply = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  try {
    globalThis.fetch = reply({
      computers: [{ id: "ascii", label: "box.ascii.dev", kind: "ascii", state: "available", configured: true, active: true }],
      activeKind: "ascii",
    });
    const named = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.equal(named.activeKind, "ascii");
    assert.equal(named.computers[0].active, true);

    // A server that names neither is not asserting anything about which is in use.
    globalThis.fetch = reply({ computers: [{ id: "ascii", label: "box", kind: "ascii" }] });
    const silent = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.equal(silent.activeKind, null);
    assert.ok(!("active" in silent.computers[0]));
  } finally {
    globalThis.fetch = realFetch;
    await cleanup();
  }
});

// Saying "the server did not say why" directly above the server's own words is
// a plain contradiction. A code we do not recognise is not a failure nobody
// explained: when a message came with it, that message IS the explanation.
test("an unrecognised failure shows what the server said, not that it said nothing", async () => {
  const src = await readFile(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs"), "utf8");
  const component = eval(/const COMPONENT_SOURCE = ([\s\S]*?);\n\n/.exec(src)[1]);
  // The unknown fallback may only be reached when there is nothing else to say.
  assert.match(component, /c=known\|\|\(detail\?\["A computer could not be set up",detail\]:ROpenGrokErrorCopy\.unknown\)/);
  // And the message must not be printed twice once it has become the description.
  assert.match(component, /detail&&known\?a\.jsx\(se,/);
});

// The main process holds both tokens and they answer different questions: the
// bearer says which gateway may be spoken to, the account token says whose
// account the call is for. Sending only the bearer would let the server fall
// back to its configured account and act on somebody else's computer.
test("a gateway call from the main process names both the gateway and the account", async () => {
  const temporary = await mkdtemp(path.join(repoRoot, ".tmp-gw-call-"));
  try {
    const outfile = path.join(temporary, "call.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/electron-main/box/opengrok-gateway-call.ts")],
      outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent",
    });
    const { callOpenGrokGateway } = await import(pathToFileURL(outfile).href);
    const secrets = { readSecret: async (k) => (k === "opengrok-gateway-token" ? "gw-bearer" : "account-jwt") };

    let seen = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { seen = { url: String(url), init }; return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); };
    try {
      const out = await callOpenGrokGateway(secrets, "http://server.test:1447/", "resetForeverBox", { agentId: "cw_1" });
      assert.deepEqual(out, { ok: true });
      assert.equal(seen.url, "http://server.test:1447/api/resetForeverBox", "a trailing slash must not double up");
      assert.equal(seen.init.headers.authorization, "Bearer gw-bearer");
      assert.equal(seen.init.headers["x-opengrok-account"], "account-jwt");
      assert.equal(seen.init.body, JSON.stringify({ agentId: "cw_1" }));

      // The server's own words beat a bare status code.
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "that coworker already has a computer" }), { status: 409 });
      await assert.rejects(() => callOpenGrokGateway(secrets, "http://server.test:1447", "resetForeverBox"), /already has a computer/);

      // A method name is never interpolated into a path unchecked.
      await assert.rejects(() => callOpenGrokGateway(secrets, "http://server.test:1447", "../../etc/passwd"), /Refusing to call/);

      // Without a bearer there is nothing to call, and it says so rather than 401ing.
      const noBearer = { readSecret: async () => null };
      await assert.rejects(() => callOpenGrokGateway(noBearer, "http://server.test:1447", "resetForeverBox"), /Sign in to your OpenGrok server/);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// Reset destroys a box and everything on it. Where the computer belongs to the
// whole organisation, that is not one person's to throw away from a settings
// panel — and the control must be absent rather than present-and-refused,
// because offering an action and then declining the click is worse than never
// offering it.
test("reset is offered for your own computer and withheld for a shared one", async () => {
  const src = await readFile(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs"), "utf8");
  const component = eval(/const COMPONENT_SOURCE = ([\s\S]*?);\n\n/.exec(src)[1]);
  // per-org renders an admin-only note and never the button.
  assert.match(component, /if\(mode==="per-org"\)return a\.jsx\(ie,/);
  assert.match(component, /Admin only/);
  // The confirmation names what is lost; a bare "are you sure" would not.
  assert.match(component, /destroys the computer and everything saved on it/);
  assert.match(component, /cannot be undone/);
  assert.match(component, /Reset and lose the files/);
  // It asks before it acts: the first press only opens the question.
  assert.match(component, /onClick:\(\)=>e\(i=>\(\{\.\.\.i,asking:!0/);

  // And the main process refuses it too, so the guard does not live only in
  // copy that a future edit could quietly drop.
  const mainEdge = await readFile(path.join(repoRoot, "source", "electron-main", "main-edge.ts"), "utf8");
  assert.match(mainEdge, /invariant\(listed\.sharingMode !== "per-org"/);
});

// Opening a computer is a request to use it. Telling the person it is asleep
// and to go type a message at it, from a panel already holding the function
// that wakes it, is a poor answer. But waking costs money at the provider, so
// it happens only from the view someone deliberately opened, and not more than
// once a minute however often React re-renders it.
test("opening a stopped computer wakes it, once, and only from the opened view", async () => {
  const src = await readFile(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs"), "utf8");
  const chrome = eval(/export const MAIN_CHROME_SOURCE = ([\s\S]*?);\n\n/.exec(src)[1]);
  const RBoxOpenPlaceholder = new Function(`${chrome}\nreturn RBoxOpenPlaceholder;`)();

  let ensured = 0;
  const stopped = { isStatusKnown: true, isStatusUnavailable: false, phase: "off", status: { state: "stopped", agentId: "cw_wake" }, ensure: () => { ensured += 1; return Promise.resolve(); } };
  const first = RBoxOpenPlaceholder(stopped, "local copy");
  assert.equal(ensured, 1, "a stopped computer is woken when its view is opened");
  assert.match(first.emptyMessage, /Waking/i, "and says so, rather than telling the person to go and type at it");
  assert.equal(first.isEmptyLoading, true);

  // A re-render must not wake it again — renders are frequent, wakes are not free.
  RBoxOpenPlaceholder(stopped, "local copy");
  RBoxOpenPlaceholder(stopped, "local copy");
  assert.equal(ensured, 1, "re-rendering must not wake the same computer repeatedly");

  // A running computer is left alone, and says what it is rather than spinning.
  let ranEnsure = 0;
  const running = { isStatusKnown: true, isStatusUnavailable: false, phase: "remote", status: { state: "running", agentId: "cw_run" }, ensure: () => { ranEnsure += 1; } };
  const up = RBoxOpenPlaceholder(running, "local copy");
  assert.equal(ranEnsure, 0, "a running computer must not be woken");
  assert.match(up.emptyMessage, /no screen/i);
  assert.equal(up.isEmptyLoading, false, "a computer that is up is not still loading");

  // An unknown status is not a stopped one: do not wake what we cannot see.
  let blind = 0;
  RBoxOpenPlaceholder({ isStatusKnown: false, isStatusUnavailable: false, status: null, ensure: () => { blind += 1; } }, "local copy");
  assert.equal(blind, 0, "a status we do not have is not a reason to wake anything");
});

// The renderer source is evaluated whole by other tests to read one function
// out of it. A bare setInterval at its top level therefore ran in the test
// process and kept it alive for ever — the suite hung rather than failed,
// which is the worse of the two.
test("evaluating the renderer source starts nothing outside a browser", async () => {
  const src = await readFile(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs"), "utf8");
  const chrome = eval(/export const MAIN_CHROME_SOURCE = ([\s\S]*?);\n\n/.exec(src)[1]);

  const realSetInterval = globalThis.setInterval;
  const started = [];
  globalThis.setInterval = (...args) => { started.push(args[1]); return realSetInterval(() => {}, 1 << 30); };
  try {
    new Function(chrome)();
    assert.deepEqual(started, [], "nothing may schedule a timer when there is no document");
  } finally {
    globalThis.setInterval = realSetInterval;
  }

  // The installer must still do its job where there IS a document.
  assert.match(chrome, /function RInstallTurnStop\(\)/);
  assert.match(chrome, /if\(typeof document==="undefined"\)return/);
});

// The server reports a per-bot provisioning failure on that bot's own row. It
// was never read, so a bot whose computer could not be made looked exactly like
// one whose computer is fine — which is the failure the field exists to prevent.
test("a bot with no computer says so, in the same words as the panel", async () => {
  const src = await readFile(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs"), "utf8");
  const chrome = eval(/export const MAIN_CHROME_SOURCE = ([\s\S]*?);\n\n/.exec(src)[1]);

  const copy = new Function(`${chrome}\nreturn RAgentIssueCopy;`)();
  // Every code the server can send needs words here too, not only in Settings.
  for (const code of ["no_org_key", "invalid_key", "quota_exceeded", "provider_unreachable", "provider_error", "not_supported", "unknown"]) {
    assert.equal(typeof copy[code], "string", `no wording for "${code}" on the agent surface`);
    assert.ok(copy[code].length > 0);
  }
  // It must talk about the bot, not the organisation's roster.
  assert.match(copy.no_org_key, /this bot/i);
  assert.match(copy.invalid_key, /this bot/i);

  // Reading the roster must never invent a failure: a roster we cannot read is
  // not a bot with a broken computer.
  const mainEdge = await readFile(path.join(repoRoot, "source", "electron-main", "main-edge.ts"), "utf8");
  assert.match(mainEdge, /catch \{\s*\n\s*\/\/ A roster we cannot read is not a bot with a broken computer\.\s*\n\s*return \{ issues: \[\] \};/);
  // And an unrecognised code still shows the server's own words.
  assert.match(chrome, /RAgentIssueCopy\[issue\.code\]\|\|issue\.message\|\|RAgentIssueCopy\.unknown/);
});
