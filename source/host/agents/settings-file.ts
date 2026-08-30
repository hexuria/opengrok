import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SAND_SETTINGS_FILENAME = "settings.json";
export const DEFAULT_NOTIFY_ON_AGENT_UPDATES = true;
export const DEFAULT_HIDDEN_FROM_SIDEBAR = false;

export interface SandAgentSettings { notifyOnAgentUpdates: boolean; hiddenFromSidebar: boolean }

export function getSandSettingsPath(agentDir: string): string { return join(agentDir, SAND_SETTINGS_FILENAME); }

function readRawSettings(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export function readSandSettingsFile(path: string): SandAgentSettings {
  const raw = readRawSettings(path);
  return {
    notifyOnAgentUpdates: typeof raw.notifyOnAgentUpdates === "boolean" ? raw.notifyOnAgentUpdates : DEFAULT_NOTIFY_ON_AGENT_UPDATES,
    hiddenFromSidebar: typeof raw.hiddenFromSidebar === "boolean" ? raw.hiddenFromSidebar : DEFAULT_HIDDEN_FROM_SIDEBAR
  };
}

export function writeSandSettingsFile(path: string, update: Partial<SandAgentSettings>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...readRawSettings(path), ...update }, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
