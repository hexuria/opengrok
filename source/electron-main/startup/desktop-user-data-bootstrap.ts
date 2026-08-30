import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

import {
  resolveSandDataRootOverride,
  resolveSandUserDataDir,
  SAND_DATA_ROOT_ENV,
  SAND_USER_DATA_DIR_ENV,
} from "../../host/host-paths.js";

import { applyStartupDataRootMigration, resolveExistingSandProductionRootDir, type DataRootSettlement } from "./startup-data-root-migration.js";
import { LEGACY_RECONSTRUCTED_USER_DATA_DIRNAME, LEGACY_RECONSTRUCTED_USER_DATA_DIRNAMES, RECONSTRUCTED_USER_DATA_DIRNAME, isReconstructedUserDataPath } from "../../shared/cursor-session-policy.js";
import { applyWindowsUserDataMigration, isWindowsUpdatedLaunch } from "./windows-user-data-migration.js";

export { RECONSTRUCTED_USER_DATA_DIRNAME, LEGACY_RECONSTRUCTED_USER_DATA_DIRNAME, LEGACY_RECONSTRUCTED_USER_DATA_DIRNAMES };

/**
 * Every bundle name this app has shipped under. The user-data directory is
 * chosen from this check, so a name dropped from the list would send an
 * existing install to a fresh profile and read as though its chats and
 * settings had been wiped. Names are only ever added here, never removed.
 */
export const RECONSTRUCTED_APP_BUNDLE_NAMES = ["Grok-0.27.app", "OpenGrok.app", "Open Grok.app"] as const;

export function isReconstructedDesktopApp(exePath = process.execPath, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SAND_RECONSTRUCTED_PROFILE === "1") return true;
  return RECONSTRUCTED_APP_BUNDLE_NAMES.some((bundleName) => exePath.includes(bundleName));
}

export const STRANDED_USER_DATA_REASONS = new Set([
  "canonical-marked",
  "canonical-unsafe",
  "conflict-preserved",
  "legacy-unsafe",
  "migration-failed",
]);

export const STRANDED_DATA_ROOT_REASONS = new Set([
  "canonical-conflict",
  "canonical-marked",
  "legacy-unsafe",
  "live-legacy-host",
  "migration-failed",
  "unknown-legacy-writer",
]);

export interface DesktopBootstrapApp {
  readonly isPackaged: boolean;
  setPath(name: "userData" | "sessionData", path: string): void;
  getPath(name: "appData" | "userData"): string;
}

export interface DesktopUserDataBootstrapOptions {
  readonly isLabBuild: boolean;
  readonly app: DesktopBootstrapApp;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  reportFailureClass?(surface: "startup", operation: "user-data-settlement", reason: string): void;
}

export function bootstrapDesktopUserData(options: DesktopUserDataBootstrapOptions): string | null {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isolatedUserDataDir = resolveSandUserDataDir(argv, env, options.cwd ?? process.cwd());
  if (isolatedUserDataDir != null) {
    env[SAND_USER_DATA_DIR_ENV] = isolatedUserDataDir;
    if (isReconstructedUserDataPath(isolatedUserDataDir) || isReconstructedDesktopApp(process.execPath, env)) {
      env.SAND_PERSIST_SECRETS_ON_DISK = env.SAND_PERSIST_SECRETS_ON_DISK ?? "1";
    }
    options.app.setPath("userData", isolatedUserDataDir);
    options.app.setPath("sessionData", isolatedUserDataDir);
    console.log(`[sand] using isolated user-data dir: ${isolatedUserDataDir}`);
    return isolatedUserDataDir;
  }
  if (options.app.isPackaged && isReconstructedDesktopApp(process.execPath, env)) {
    const reconstructedDir = join(options.app.getPath("appData"), RECONSTRUCTED_USER_DATA_DIRNAME);
    // One-time OpenGrok rebrand migration: adopt the pre-rebrand profile so
    // existing chats, attachments, and settings are never orphaned.
    try {
      if (!existsSync(reconstructedDir)) {
        for (const legacyName of LEGACY_RECONSTRUCTED_USER_DATA_DIRNAMES) {
          const legacyDir = join(options.app.getPath("appData"), legacyName);
          if (!existsSync(legacyDir)) continue;
          renameSync(legacyDir, reconstructedDir);
          console.log(`[sand] migrated user-data dir: ${legacyDir} -> ${reconstructedDir}`);
          break;
        }
      }
    } catch (error) {
      console.log(`[sand] user-data migration skipped: ${String(error)}`);
    }
    env[SAND_USER_DATA_DIR_ENV] = reconstructedDir;
    env.SAND_PERSIST_SECRETS_ON_DISK = env.SAND_PERSIST_SECRETS_ON_DISK ?? "1";
    options.app.setPath("userData", reconstructedDir);
    options.app.setPath("sessionData", reconstructedDir);
    console.log(`[sand] using reconstructed user-data dir: ${reconstructedDir}`);
    return reconstructedDir;
  }
  const settlement = applyWindowsUserDataMigration({
    platform,
    isPackaged: options.app.isPackaged,
    isLabBuild: options.isLabBuild,
    hasIsolatedUserData: false,
    isUpdatedLaunch: isWindowsUpdatedLaunch(argv),
    appDataDir: options.app.getPath("appData"),
    canonicalUserDataDir: options.app.getPath("userData"),
    setPath: (name, path) => options.app.setPath(name, path),
  });
  if (STRANDED_USER_DATA_REASONS.has(settlement.reason)) {
    options.reportFailureClass?.("startup", "user-data-settlement", settlement.reason);
  }
  return null;
}

export interface DesktopDataRootBootstrapOptions {
  readonly isPrimaryInstance: boolean;
  readonly isLabBuild: boolean;
  readonly hasIsolatedUserData: boolean;
  readonly app: Pick<DesktopBootstrapApp, "isPackaged">;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  reportFailureClass?(surface: "startup", operation: "data-root-settlement", reason: string): void;
}

export function bootstrapDesktopDataRoot(options: DesktopDataRootBootstrapOptions): DataRootSettlement | null {
  if (!options.isPrimaryInstance) return null;
  const env = options.env ?? process.env;
  if (!options.app.isPackaged && env.SAND_ATTACH_PROD_BOX === "1"
    && !options.hasIsolatedUserData && resolveSandDataRootOverride(env) == null) {
    env[SAND_DATA_ROOT_ENV] = resolveExistingSandProductionRootDir(options.homeDir);
    return null;
  }
  const settlement = applyStartupDataRootMigration({
    isPackaged: options.app.isPackaged,
    isLabBuild: options.isLabBuild,
    hasIsolatedUserData: options.hasIsolatedUserData,
    env,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
  if (STRANDED_DATA_ROOT_REASONS.has(settlement.reason)) {
    options.reportFailureClass?.("startup", "data-root-settlement", settlement.reason);
  }
  return settlement;
}
