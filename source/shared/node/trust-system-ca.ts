// Node's TLS trust is its own bundled CA list; it does not read the macOS keychain. Chromium
// (the renderer) does, so a self-signed gateway behind a locally trusted CA works in the page
// and fails in every Node process that talks to the gateway: the coordinator's fetch answered
// UNABLE_TO_GET_ISSUER_CERT_LOCALLY for https://192.168.100.24:1448 while curl and the page
// were fine (2 Sep 2026). Node 24 exposes the system store (`tls.getCACertificates("system")`)
// and lets a process replace its defaults, so each Node entrypoint adds the system roots to the
// bundled ones once at start. No launch flags, so it holds when the app starts from the Dock.
import tls from "node:tls";

export const TRUST_SYSTEM_CA_ENV = "SAND_TRUST_SYSTEM_CA";

let applied: { bundled: number; system: number } | null = null;

/** Add the OS trust store's roots to Node's default CA list. Idempotent; never throws. Returns
 *  what was installed, or `null` when disabled (`SAND_TRUST_SYSTEM_CA=0`) or unsupported. */
export function trustSystemCertificateAuthorities(env: NodeJS.ProcessEnv = process.env): { bundled: number; system: number } | null {
  if (applied != null) return applied;
  if (env[TRUST_SYSTEM_CA_ENV] === "0") return null;
  const t = tls as unknown as { getCACertificates?: (type: string) => string[]; setDefaultCACertificates?: (certs: string[]) => void };
  if (typeof t.getCACertificates !== "function" || typeof t.setDefaultCACertificates !== "function") return null;
  try {
    // "default", not "bundled": the default list is the bundled roots PLUS anything the
    // person put in NODE_EXTRA_CA_CERTS (a corporate proxy root, say). Starting from "bundled"
    // would silently drop those and break the very connection this helper exists to fix.
    const bundled = t.getCACertificates("default");
    const system = t.getCACertificates("system");
    if (system.length === 0) { applied = { bundled: bundled.length, system: 0 }; return applied; }
    t.setDefaultCACertificates([...bundled, ...system]);
    applied = { bundled: bundled.length, system: system.length };
    return applied;
  } catch {
    return null;
  }
}

/** Tests only. */
export function resetTrustSystemCertificateAuthoritiesForTests(): void { applied = null; }
