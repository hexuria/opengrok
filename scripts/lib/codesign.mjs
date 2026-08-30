import { run } from "./process.mjs";

export const AD_HOC_CODESIGN_IDENTITY = "-";
export const CODESIGN_IDENTITY_ENV = "SAND_CODESIGN_IDENTITY";
export const NONINTERACTIVE_CODESIGN_STDIO = Object.freeze([
  "ignore",
  "inherit",
  "inherit",
]);

/**
 * macOS privacy grants (Full Disk Access, Automation) are keyed to the app's
 * designated requirement. An ad-hoc signature has no team or stable identifier,
 * so its requirement is a bare cdhash — which changes on every build, taking
 * every granted permission with it. A Developer ID signature makes the
 * requirement `identifier … and certificate leaf[subject.OU] = <team>`, which
 * survives rebuilds, so Messages access has to be granted only once.
 */
export function parseSigningIdentities(securityOutput) {
  if (typeof securityOutput !== "string") return [];
  const identities = [];
  for (const line of securityOutput.split("\n")) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/.exec(line);
    if (match == null) continue;
    identities.push({ hash: match[1], name: match[2] });
  }
  return identities;
}

/**
 * Developer ID is preferred over Apple Development because a development
 * certificate is tied to a provisioning profile and expires in a year; the
 * grant would lapse with it.
 */
export function pickCodesignIdentity(identities) {
  const named = (prefix) => identities.find((identity) => identity.name.startsWith(prefix))?.name;
  return named("Developer ID Application:") ?? named("Apple Development:");
}

export async function resolveCodesignIdentity(options = {}) {
  const env = options.env ?? process.env;
  const configured = env[CODESIGN_IDENTITY_ENV]?.trim();
  if (configured != null && configured.length > 0) return configured;
  const list = options.listIdentities ?? defaultListIdentities;
  try {
    return pickCodesignIdentity(parseSigningIdentities(await list())) ?? AD_HOC_CODESIGN_IDENTITY;
  } catch {
    return AD_HOC_CODESIGN_IDENTITY;
  }
}

async function defaultListIdentities() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  return stdout;
}

export function codesignArguments(target, identity = AD_HOC_CODESIGN_IDENTITY) {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("An explicit application bundle path is required for signing.");
  }
  return [
    "--force",
    "--deep",
    // No timestamp: the signature is for local identity, not distribution, and
    // a timestamp would make packaging depend on Apple's server being reachable.
    "--timestamp=none",
    "--sign",
    identity,
    target,
  ];
}

export function adHocCodesignArguments(target) {
  return codesignArguments(target, AD_HOC_CODESIGN_IDENTITY);
}

export async function signAppBundle(target, runCommand = run, options = {}) {
  const identity = options.identity ?? await resolveCodesignIdentity(options);
  await runCommand("/usr/bin/codesign", codesignArguments(target, identity), {
    stdio: NONINTERACTIVE_CODESIGN_STDIO,
  });
  return identity;
}

export async function signAppBundleAdHoc(target, runCommand = run) {
  return await signAppBundle(target, runCommand, { identity: AD_HOC_CODESIGN_IDENTITY });
}
