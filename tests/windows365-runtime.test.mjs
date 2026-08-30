import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows 365 checkout uses pool, session id, and user object id", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "w365-client-"));
  try {
    const outfile = path.join(temporary, "client.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/electron-main/box/windows365/windows365-client.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    const clientMod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: "11111111-1111-4111-8111-111111111111",
          computerUrl: "https://device.windows365.microsoft.com/computers/pc-1",
          computerId: "pc-1",
          status: "Succeeded",
        }),
      };
    };
    const tokens = {
      getToken: async () => "tok",
    };
    const client = clientMod.createWindows365Client({
      sessionBaseUrl: "https://windows365.microsoft.com",
      poolId: "pool-9",
      tokens,
      fetchImpl,
    });
    const checkout = await client.checkout({
      userObjectId: "oid-42",
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    assert.equal(checkout.computerId, "pc-1");
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /\/api\/pools\/pool-9\/sessions/);
    assert.equal(calls[0].headers["user-object-id"], "oid-42");
    assert.equal(calls[0].headers["x-ms-sessionId"], "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Windows 365 credentials stay complete only with a secret and reuse one account session", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "w365-"));
  try {
    const outfile = path.join(temporary, "credentials.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/electron-main/box/windows365/windows365-credentials.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    const sessionOut = path.join(temporary, "session.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/electron-main/box/windows365/windows365-session.ts")],
      outfile: sessionOut,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    const credentials = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
    const session = await import(`${pathToFileURL(sessionOut).href}?${Date.now() + 1}`);
    const settingsPath = path.join(temporary, "settings.json");
    const first = await credentials.writeWindows365Credentials(settingsPath, {
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
      poolId: "p",
      userObjectId: "u",
    });
    assert.equal(credentials.windows365CredentialsAreComplete(first), true);
    const publicSettings = credentials.toWindows365PublicSettings(first);
    assert.equal(publicSettings.hasClientSecret, true);
    assert.equal("clientSecret" in publicSettings, false);
    const again = await credentials.writeWindows365Credentials(settingsPath, { poolId: "p2" });
    assert.equal(again.clientSecret, "s");
    assert.equal(again.accountSessionId, first.accountSessionId);
    assert.equal(session.shouldReuseWindows365Session({
      sessionId: first.accountSessionId,
      computerId: "pc",
      computerUrl: "https://device/computers/pc",
      status: "Ready",
      checkedOutAtMs: 1,
    }, true), true);
    assert.equal(session.shouldReuseWindows365Session(null, true), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("settings expose a Computer section and box runtime includes windows365", async () => {
  const view = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/view.tsx"), "utf8");
  assert.doesNotMatch(view, /\{ id: "computer", label: "Computer", icon: "computer" \}/);
  assert.match(view, /\{ id: "router", label: "Router", icon: "git-branch" \}/);
  const runtime = await readFile(path.join(repoRoot, "source/shared/box-runtime.ts"), "utf8");
  assert.match(runtime, /"windows365"/);
  assert.match(runtime, /usesLocalAgentHost/);
  const session = await readFile(path.join(repoRoot, "source/electron-main/box/windows365/windows365-session.ts"), "utf8");
  assert.match(session, /Settings → Router → Computer/);
  assert.doesNotMatch(session, /Settings → Computer\./);
  const patch = await readFile(path.join(repoRoot, "scripts/lib/router-renderer-patch.mjs"), "utf8");
  assert.match(patch, /function RW365Setup/);
  assert.match(patch, /checkoutWindows365/);
  assert.match(patch, /Windows 365 credentials/);
  assert.match(patch, /boxSizing:"border-box"/);
  assert.match(patch, /maxWidth:420/);
  assert.doesNotMatch(patch, /title:"Windows 365 credentials"/);
});
