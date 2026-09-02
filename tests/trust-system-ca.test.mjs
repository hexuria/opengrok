import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadHelper() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-trust-system-ca-"));
  const outfile = path.join(temporary, "trust-system-ca.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/shared/node/trust-system-ca.ts")], outfile, bundle: true, format: "esm", platform: "node", target: "node22" });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// Node's TLS trust is its bundled list; it does not read the OS keychain. A gateway behind a
// locally trusted CA therefore worked in the page (Chromium) and failed in the coordinator
// (UNABLE_TO_GET_ISSUER_CERT_LOCALLY). Each Node entrypoint now adds the OS roots once.
test("the OS trust store's roots are added to Node's defaults, once", async () => {
  const { loaded, cleanup } = await loadHelper();
  try {
    const supported = typeof tls.getCACertificates === "function" && typeof tls.setDefaultCACertificates === "function";
    const before = supported ? tls.getCACertificates("default").length : 0;
    const first = loaded.trustSystemCertificateAuthorities({});
    if (!supported) { assert.equal(first, null, "older Node: a no-op, never a throw"); return; }
    assert.ok(first, "supported Node must apply");
    assert.equal(first.bundled, tls.getCACertificates("bundled").length);
    // Node de-duplicates roots the OS store shares with the bundle (most of them on Linux and
    // Windows), so the count is not a sum: assert containment instead.
    // Node de-duplicates roots the OS store shares with the bundle (most of them on Linux and
    // Windows) and re-wraps the PEM text it hands back, so compare normalized bodies, not counts.
    const body = (pem) => pem.replace(/\s+/g, "");
    const after = new Set(tls.getCACertificates("default").map(body));
    for (const pem of tls.getCACertificates("bundled")) assert.ok(after.has(body(pem)), "every bundled root stays");
    for (const pem of tls.getCACertificates("system")) assert.ok(after.has(body(pem)), "every system root is trusted");
    if (first.system === 0) assert.equal(after.size, before, "no system roots: defaults untouched");
    // Idempotent: a second call reports the same and changes nothing.
    assert.deepEqual(loaded.trustSystemCertificateAuthorities({}), first);
    assert.equal(tls.getCACertificates("default").length, after.size);
  } finally {
    await cleanup();
  }
});

test("SAND_TRUST_SYSTEM_CA=0 keeps Node's bundled list only", async () => {
  const { loaded, cleanup } = await loadHelper();
  try {
    loaded.resetTrustSystemCertificateAuthoritiesForTests();
    assert.equal(loaded.trustSystemCertificateAuthorities({ SAND_TRUST_SYSTEM_CA: "0" }), null);
  } finally {
    await cleanup();
  }
});

test("every Node entrypoint that reaches the gateway trusts the OS roots at start", async () => {
  for (const file of ["source/electron-main/main.ts", "source/node-agent-coordinator/main.ts", "source/local-exec-daemon/main.ts"]) {
    const src = await readFile(path.join(repoRoot, file), "utf8");
    assert.match(src, /trustSystemCertificateAuthorities\(\)/, `${file} must call the helper`);
  }
});
