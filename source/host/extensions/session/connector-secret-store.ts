import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSafeFolderId } from "../../storage/folder-id.js";
import { reportSessionDiagnostic } from "./session-diagnostics.js";

type SecretRecord = Record<string, unknown>;
function errorClass(error: unknown): string { return error instanceof Error ? error.name : typeof error; }

export class SandConnectorSecretStore {
  constructor(readonly secretsRoot: string) {}
  filePath(agentId: string, platform: string): string { return join(this.secretsRoot, agentId, `${platform}.json`); }
  read(agentId: string, platform: string): SecretRecord {
    try { const parsed: unknown = JSON.parse(readFileSync(this.filePath(agentId, platform), "utf8")); return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SecretRecord : {}; }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") reportSessionDiagnostic({ family: "store_db", kind: "connector_secrets_unreadable", agentId, errorClass: errorClass(error) });
      return {};
    }
  }
  setSecret(agentId: string, platform: string, field: string, value: string): boolean {
    if (!isSafeFolderId(agentId) || !isSafeFolderId(platform) || field.length === 0) return false;
    const path = this.filePath(agentId, platform), merged = { ...this.read(agentId, platform), [field]: value };
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8"); renameSync(tempPath, path); return true;
  }
  getSecret(agentId: string, platform: string, field: string): string | null {
    if (!isSafeFolderId(agentId) || !isSafeFolderId(platform)) return null;
    const value = this.read(agentId, platform)[field]; return typeof value === "string" && value.length > 0 ? value : null;
  }
  removeAgentPlatform(agentId: string, platform: string): void { if (isSafeFolderId(agentId) && isSafeFolderId(platform)) rmSync(this.filePath(agentId, platform), { force: true }); }
}
