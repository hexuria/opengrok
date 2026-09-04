import { rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  NONINTERACTIVE_CODESIGN_STDIO,
  distributionCodesignArguments,
  resolveCodesignIdentity,
  signAppBundleForDistribution,
} from "./codesign.mjs";
import { run } from "./process.mjs";
import { SYSTEM_TOOLS } from "./system-tools.mjs";

export function distributionZipPath(appPath) {
  if (typeof appPath !== "string" || appPath.length === 0) {
    throw new TypeError("An application bundle path is required.");
  }
  if (path.extname(appPath) !== ".app") {
    throw new TypeError("An application bundle path ending in .app is required.");
  }
  return path.join(path.dirname(appPath), `${path.basename(appPath, ".app")}.zip`);
}

export function dittoZipArguments(appPath, zipPath) {
  if (typeof appPath !== "string" || appPath.length === 0) {
    throw new TypeError("An application bundle path is required.");
  }
  if (typeof zipPath !== "string" || zipPath.length === 0) {
    throw new TypeError("A zip destination path is required.");
  }
  return ["-c", "-k", "--keepParent", appPath, zipPath];
}

function envFlagEnabled(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function shouldNotarize(env = process.env) {
  return envFlagEnabled(env.SAND_NOTARIZE);
}

export function resolveNotaryCredentials(env = process.env) {
  if (!shouldNotarize(env)) return null;
  const profile = env.SAND_NOTARY_KEYCHAIN_PROFILE?.trim();
  if (profile) return { type: "keychain-profile", profile };
  const keyPath = env.SAND_NOTARY_API_KEY_PATH?.trim();
  const keyId = env.SAND_NOTARY_API_KEY_ID?.trim();
  const issuer = env.SAND_NOTARY_ISSUER?.trim();
  if (keyPath && keyId && issuer) {
    assertNotaryApiKeyPath(keyPath);
    return { type: "api-key", key: keyPath, keyId, issuer };
  }
  throw new Error("SAND_NOTARIZE is set but neither SAND_NOTARY_KEYCHAIN_PROFILE nor SAND_NOTARY_API_KEY_PATH + SAND_NOTARY_API_KEY_ID + SAND_NOTARY_ISSUER are configured.");
}

export function assertNotaryApiKeyPath(keyPath) {
  if (typeof keyPath !== "string" || keyPath.length === 0) {
    throw new TypeError("SAND_NOTARY_API_KEY_PATH must be a filesystem path to a .p8 file.");
  }
  if (/-----BEGIN/.test(keyPath) || keyPath.includes("\n") || keyPath.includes("\r")) {
    throw new Error("SAND_NOTARY_API_KEY_PATH must be a filesystem path to a .p8 file, not the key PEM.");
  }
}

export function notarytoolSubmitArguments(zipPath, credentials) {
  if (typeof zipPath !== "string" || zipPath.length === 0) {
    throw new TypeError("A zip path is required for notarization.");
  }
  if (credentials?.type === "keychain-profile") {
    return ["notarytool", "submit", zipPath, "--wait", "--keychain-profile", credentials.profile];
  }
  if (credentials?.type === "api-key") {
    return ["notarytool", "submit", zipPath, "--wait", "--key", credentials.key, "--key-id", credentials.keyId, "--issuer", credentials.issuer];
  }
  throw new TypeError("Notary credentials are required.");
}

export function staplerStapleArguments(appPath) {
  if (typeof appPath !== "string" || appPath.length === 0) {
    throw new TypeError("An application bundle path is required.");
  }
  return ["stapler", "staple", appPath];
}

export async function zipAppBundle(appPath, zipPath, runCommand = run) {
  await rm(zipPath, { force: true });
  await runCommand(SYSTEM_TOOLS.ditto, dittoZipArguments(appPath, zipPath));
  return zipPath;
}

async function assertPackagedApp(appPath) {
  try {
    if (!(await stat(appPath)).isDirectory()) {
      throw new Error(`Missing packaged application: ${appPath}. Run npm run package first.`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing packaged application: ${appPath}. Run npm run package first.`);
    }
    throw error;
  }
}

export async function releaseMacosApp(options = {}) {
  const appPath = options.appPath;
  if (typeof appPath !== "string" || appPath.length === 0) {
    throw new TypeError("An application bundle path is required.");
  }
  await assertPackagedApp(appPath);

  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? run;
  const zipPath = options.zipPath ?? distributionZipPath(appPath);
  const credentials = resolveNotaryCredentials(env);
  const identity = options.identity ?? await resolveCodesignIdentity({
    env,
    listIdentities: options.listIdentities,
  });
  const signOptions = {
    env,
    identity,
    entitlements: options.entitlements,
    listIdentities: options.listIdentities,
  };
  // Refuse ad-hoc / Apple Development before the codesign retry; only a
  // Developer ID Application identity can be timestamped and notarized.
  distributionCodesignArguments(appPath, identity, signOptions);

  try {
    await signAppBundleForDistribution(appPath, runCommand, signOptions);
  } catch (error) {
    console.warn(`Initial signing pass failed; retrying once: ${String(error)}`);
    await signAppBundleForDistribution(appPath, runCommand, signOptions);
  }

  await runCommand(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", appPath], {
    stdio: NONINTERACTIVE_CODESIGN_STDIO,
  });
  await zipAppBundle(appPath, zipPath, runCommand);

  let notarized = false;
  if (credentials != null) {
    await runCommand(SYSTEM_TOOLS.xcrun, notarytoolSubmitArguments(zipPath, credentials), {
      stdio: NONINTERACTIVE_CODESIGN_STDIO,
    });
    await runCommand(SYSTEM_TOOLS.xcrun, staplerStapleArguments(appPath), {
      stdio: NONINTERACTIVE_CODESIGN_STDIO,
    });
    await zipAppBundle(appPath, zipPath, runCommand);
    notarized = true;
  }

  return { identity, zipPath, notarized };
}
