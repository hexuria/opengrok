import path from "node:path";

import { repoRoot } from "./config.mjs";
import { run } from "./process.mjs";

export const AD_HOC_CODESIGN_IDENTITY = "-";
export const CODESIGN_IDENTITY_ENV = "SAND_CODESIGN_IDENTITY";
export const ELECTRON_ENTITLEMENTS_PATH = path.join(repoRoot, "scripts", "macos-entitlements.plist");
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

export function codesignArguments(target, identity = AD_HOC_CODESIGN_IDENTITY, options = {}) {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("An explicit application bundle path is required for signing.");
  }
  const args = ["--force", "--deep"];
  if (options.timestamp === true) {
    args.push("--timestamp");
  } else {
    // No timestamp: the signature is for local identity, not distribution, and
    // a timestamp would make packaging depend on Apple's server being reachable.
    args.push("--timestamp=none");
  }
  if (options.hardenedRuntime) {
    args.push("--options", "runtime");
  }
  if (options.entitlements != null) {
    if (typeof options.entitlements !== "string" || options.entitlements.length === 0) {
      throw new TypeError("An entitlements path is required when signing with entitlements.");
    }
    args.push("--entitlements", options.entitlements);
  }
  args.push("--sign", identity, target);
  return args;
}

export function distributionCodesignArguments(target, identity, options = {}) {
  if (typeof identity !== "string" || identity.length === 0 || identity === AD_HOC_CODESIGN_IDENTITY) {
    throw new Error("Distribution signing requires a Developer ID identity; ad-hoc signatures cannot be timestamped or notarized.");
  }
  const entitlements = options.entitlements ?? ELECTRON_ENTITLEMENTS_PATH;
  return codesignArguments(target, identity, {
    timestamp: true,
    hardenedRuntime: true,
    entitlements,
  });
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

export async function signAppBundleForDistribution(target, runCommand = run, options = {}) {
  const identity = options.identity ?? await resolveCodesignIdentity(options);
  await runCommand("/usr/bin/codesign", distributionCodesignArguments(target, identity, options), {
    stdio: NONINTERACTIVE_CODESIGN_STDIO,
  });
  return identity;
}
