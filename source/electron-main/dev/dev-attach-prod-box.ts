import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ATTACH_PROD_BOX_PREFS_PATH = join(homedir(), ".cursor", "sand-dev", "attach-prod-box.json");
export const DEFAULT_ATTACH_PROD_BOX_PREFS = { enabled: false, updatedAtMs: 0 } as const;
export interface AttachProdBoxPrefs { readonly enabled: boolean; readonly updatedAtMs: number }
export interface AttachProdBoxStatus { readonly preferred: boolean; readonly active: boolean; readonly prefsPath: string; readonly updatedAtMs: number }

export function readAttachProdBoxPrefs(path = ATTACH_PROD_BOX_PREFS_PATH): AttachProdBoxPrefs {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed == null || typeof parsed !== "object" || !("enabled" in parsed) || typeof parsed.enabled !== "boolean") {
      return DEFAULT_ATTACH_PROD_BOX_PREFS;
    }
    return {
      enabled: parsed.enabled,
      updatedAtMs: "updatedAtMs" in parsed && typeof parsed.updatedAtMs === "number" ? parsed.updatedAtMs : 0,
    };
  } catch { return DEFAULT_ATTACH_PROD_BOX_PREFS; }
}

export function writeAttachProdBoxPrefs(enabled: boolean, path = ATTACH_PROD_BOX_PREFS_PATH, now = Date.now): AttachProdBoxPrefs {
  const prefs = { enabled, updatedAtMs: now() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
  return prefs;
}

export function resolveAttachProdBoxPreferred(env: NodeJS.ProcessEnv = process.env, path = ATTACH_PROD_BOX_PREFS_PATH): boolean {
  const raw = env.SAND_ATTACH_PROD_BOX?.trim();
  if (raw === "1") return true;
  if (raw === "0") return false;
  return readAttachProdBoxPrefs(path).enabled;
}

export function isAttachProdBoxActive(env: NodeJS.ProcessEnv = process.env): boolean { return env.SAND_ATTACH_PROD_BOX === "1"; }

export function getAttachProdBoxStatus(env: NodeJS.ProcessEnv = process.env, path = ATTACH_PROD_BOX_PREFS_PATH): AttachProdBoxStatus {
  const prefs = readAttachProdBoxPrefs(path);
  return {
    preferred: resolveAttachProdBoxPreferred(env, path),
    active: isAttachProdBoxActive(env),
    prefsPath: path,
    updatedAtMs: prefs.updatedAtMs,
  };
}
