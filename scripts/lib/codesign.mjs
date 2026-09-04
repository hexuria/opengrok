import { open, readdir } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "./config.mjs";
import { run } from "./process.mjs";

export const AD_HOC_CODESIGN_IDENTITY = "-";
export const CODESIGN_IDENTITY_ENV = "SAND_CODESIGN_IDENTITY";
export const DEVELOPER_ID_APPLICATION_PREFIX = "Developer ID Application:";
export const IDENTITY_HASH_PATTERN = /^[0-9A-Fa-f]{40}$/;
export const ELECTRON_ENTITLEMENTS_PATH = path.join(repoRoot, "scripts", "macos-entitlements.plist");
export const ELECTRON_HELPER_ENTITLEMENTS_PATH = path.join(repoRoot, "scripts", "macos-helper-entitlements.plist");
export const NONINTERACTIVE_CODESIGN_STDIO = Object.freeze([
  "ignore",
  "inherit",
  "inherit",
]);
export const LOCAL_CODESIGN_OPTIONS = Object.freeze({
  timestamp: false,
  hardenedRuntime: false,
  deep: true,
});

const NESTED_BUNDLE_EXTENSIONS = new Set([".app", ".framework", ".xpc", ".appex", ".bundle"]);
const NESTED_LIBRARY_EXTENSIONS = new Set([".dylib", ".so", ".node"]);
const SKIP_SIGN_NAMES = new Set(["_CodeSignature", "CodeResources"]);
const MACHO_MAGICS = new Set([
  0xfeedface,
  0xfeedfacf,
  0xcefaedfe,
  0xcffaedfe,
  0xcafebabe,
  0xcafebabf,
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
  return named(DEVELOPER_ID_APPLICATION_PREFIX) ?? named("Apple Development:");
}

export function isIdentityHash(identity) {
  return typeof identity === "string" && IDENTITY_HASH_PATTERN.test(identity);
}

export function isDeveloperIdApplicationIdentity(identity, identities = []) {
  if (typeof identity !== "string" || identity.length === 0) return false;
  if (identity.startsWith(DEVELOPER_ID_APPLICATION_PREFIX)) return true;
  if (!isIdentityHash(identity)) return false;
  const match = identities.find((item) => item.hash.toLowerCase() === identity.toLowerCase());
  return Boolean(match?.name.startsWith(DEVELOPER_ID_APPLICATION_PREFIX));
}

export async function loadSigningIdentities(options = {}) {
  if (Array.isArray(options.identities)) return options.identities;
  const list = options.listIdentities ?? defaultListIdentities;
  try {
    return parseSigningIdentities(await list());
  } catch {
    return [];
  }
}

export function entitlementsPathForDistributionTarget(target, rootAppPath, options = {}) {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("An explicit application bundle path is required for signing.");
  }
  if (path.resolve(target) === path.resolve(rootAppPath)) {
    return options.entitlements ?? ELECTRON_ENTITLEMENTS_PATH;
  }
  if (path.extname(target) === ".app") {
    return options.helperEntitlements ?? ELECTRON_HELPER_ENTITLEMENTS_PATH;
  }
  return null;
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
  const args = ["--force"];
  if (options.deep !== false) {
    args.push("--deep");
  }
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
  if (!isDeveloperIdApplicationIdentity(identity, options.identities ?? [])) {
    throw new Error("Distribution signing requires a Developer ID Application identity; ad-hoc and Apple Development signatures cannot be notarized.");
  }
  const entitlements = Object.hasOwn(options, "entitlements")
    ? options.entitlements
    : ELECTRON_ENTITLEMENTS_PATH;
  return codesignArguments(target, identity, {
    timestamp: true,
    hardenedRuntime: true,
    entitlements,
    deep: false,
  });
}

export function adHocCodesignArguments(target) {
  return codesignArguments(target, AD_HOC_CODESIGN_IDENTITY);
}

export function compareSignTargetDepth(a, b) {
  const depth = b.split(path.sep).length - a.split(path.sep).length;
  if (depth !== 0) return depth;
  if (b.length !== a.length) return b.length - a.length;
  return a.localeCompare(b);
}

async function fileIsMachO(filePath) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    return MACHO_MAGICS.has(buf.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function collectNestedSignTargets(dir, appPath, nested) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const rootMacOS = path.join(appPath, "Contents", "MacOS");
  for (const entry of entries) {
    if (SKIP_SIGN_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    const ext = path.extname(entry.name);
    if (entry.isDirectory()) {
      if (NESTED_BUNDLE_EXTENSIONS.has(ext)) nested.push(full);
      await collectNestedSignTargets(full, appPath, nested);
      continue;
    }
    if (!entry.isFile()) continue;
    if (NESTED_LIBRARY_EXTENSIONS.has(ext)) {
      nested.push(full);
      continue;
    }
    if (path.dirname(full) === rootMacOS) continue;
    if (await fileIsMachO(full)) nested.push(full);
  }
}

export async function listNestedDistributionSignTargets(appPath) {
  if (typeof appPath !== "string" || appPath.length === 0) {
    throw new TypeError("An explicit application bundle path is required for signing.");
  }
  const nested = [];
  await collectNestedSignTargets(path.join(appPath, "Contents"), appPath, nested);
  nested.sort(compareSignTargetDepth);
  return nested;
}

export async function signAppBundle(target, runCommand = run, options = {}) {
  const identity = options.identity ?? await resolveCodesignIdentity(options);
  // Local packaging only. timestamp / hardenedRuntime / entitlements on
  // `options` are ignored; callers that need a notarizable signature must use
  // signAppBundleForDistribution.
  await runCommand("/usr/bin/codesign", codesignArguments(target, identity, LOCAL_CODESIGN_OPTIONS), {
    stdio: NONINTERACTIVE_CODESIGN_STDIO,
  });
  return identity;
}

export async function signAppBundleAdHoc(target, runCommand = run) {
  return await signAppBundle(target, runCommand, { identity: AD_HOC_CODESIGN_IDENTITY });
}

export async function signAppBundleForDistribution(target, runCommand = run, options = {}) {
  const identity = options.identity ?? await resolveCodesignIdentity(options);
  const identities = await loadSigningIdentities(options);
  const signOptions = { ...options, identities };
  if (!isDeveloperIdApplicationIdentity(identity, identities)) {
    throw new Error("Distribution signing requires a Developer ID Application identity; ad-hoc and Apple Development signatures cannot be notarized.");
  }
  const listNested = options.listNestedTargets ?? listNestedDistributionSignTargets;
  const nested = await listNested(target);
  for (const nestedTarget of nested) {
    await runCommand("/usr/bin/codesign", distributionCodesignArguments(nestedTarget, identity, {
      ...signOptions,
      entitlements: entitlementsPathForDistributionTarget(nestedTarget, target, options),
    }), {
      stdio: NONINTERACTIVE_CODESIGN_STDIO,
    });
  }
  await runCommand("/usr/bin/codesign", distributionCodesignArguments(target, identity, {
    ...signOptions,
    entitlements: entitlementsPathForDistributionTarget(target, target, options),
  }), {
    stdio: NONINTERACTIVE_CODESIGN_STDIO,
  });
  return identity;
}
