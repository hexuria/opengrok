import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentWorkflowEnablementPath } from "./agent-workflow-enablement.js";
import { listConventionalAvatarFilenames, resolveDerivedAvatarFilename } from "./agent-avatar.js";
import { getSandProfilePath, readLegacyProfileAvatarField, readSandProfileFile, writeSandProfileFile } from "./agent-profile.js";
import { getSandSettingsPath, writeSandSettingsFile } from "./settings-file.js";

export class SandAgentCloneError extends Error { override name = "SandAgentCloneError"; }
export const STORE_FILENAME = "store.db";
export const AUTOMATION_CONFIG_FILENAME = "automation.json";
export function listAgentAutomationConfigFiles(automationsDir: string): Array<{ folderName: string; configPath: string }> { try { return readdirSync(automationsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => ({ folderName: entry.name, configPath: join(automationsDir, entry.name, AUTOMATION_CONFIG_FILENAME) })).filter(entry => existsSync(entry.configPath)); } catch { return []; } }
export function cloneAgentDisplayName(name: string): string { const trimmed = name.trim(); return trimmed.length > 0 ? `${trimmed} copy` : "copy"; }
function copyIfPresent(source: string, target: string): void { if (existsSync(source)) copyFileSync(source, target); }
export interface AgentCloneAdapters { getAutomationsDir(agentDir: string): string; checkpointStore(path: string): void; rewriteIdentity(targetDir: string, newAgentId: string, includesChatHistory: false): void }
export function cloneAgentDir(sourceDir: string, targetDir: string, newAgentId: string, cloneName: string, adapters: AgentCloneAdapters): void {
  mkdirSync(targetDir, { recursive: true });
  try {
    const store = join(sourceDir, STORE_FILENAME); if (!existsSync(store)) throw new SandAgentCloneError("This agent's data is missing and can't be duplicated."); adapters.checkpointStore(store); copyFileSync(store, join(targetDir, STORE_FILENAME));
    const profile = readSandProfileFile(getSandProfilePath(sourceDir)); writeSandProfileFile(getSandProfilePath(targetDir), { name: cloneName, description: profile?.description ?? "", title: profile?.title ?? "", avatarShape: profile?.avatarShape ?? "", avatarColor: profile?.avatarColor ?? "" });
    copyIfPresent(getSandSettingsPath(sourceDir), getSandSettingsPath(targetDir)); writeSandSettingsFile(getSandSettingsPath(targetDir), { hiddenFromSidebar: false });
    copyIfPresent(getAgentWorkflowEnablementPath(sourceDir), getAgentWorkflowEnablementPath(targetDir));
    resolveDerivedAvatarFilename(sourceDir, readLegacyProfileAvatarField(getSandProfilePath(sourceDir))); for (const name of listConventionalAvatarFilenames(sourceDir)) copyFileSync(join(sourceDir, name), join(targetDir, name));
    for (const entry of listAgentAutomationConfigFiles(adapters.getAutomationsDir(sourceDir))) { const destination = join(adapters.getAutomationsDir(targetDir), entry.folderName); mkdirSync(destination, { recursive: true }); copyFileSync(entry.configPath, join(destination, AUTOMATION_CONFIG_FILENAME)); }
    adapters.rewriteIdentity(targetDir, newAgentId, false);
  } catch (error) { rmSync(targetDir, { recursive: true, force: true }); throw error; }
}
