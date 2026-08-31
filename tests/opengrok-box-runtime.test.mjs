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
      { id: "local-docker", label: "Local VM (on the server)", kind: "local-docker", state: "available", configured: true },
      { id: "ascii", label: "box.ascii.dev", kind: "ascii", state: "not-configured", configured: false },
      { id: "windows365", label: "Windows 365", kind: "windows365", state: "not-configured", configured: false },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const { computers: rows } = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.configured), [true, false, false]);
    assert.deepEqual(rows.map((row) => row.label), ["Local VM (on the server)", "box.ascii.dev", "Windows 365"]);
    assert.deepEqual(rows.map((row) => row.kind), ["local-docker", "ascii", "windows365"]);
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
