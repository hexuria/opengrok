import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDebouncePolicy, realClock } from "../../../internal/scheduling.js";
import { isSafeFolderId } from "../../storage/folder-id.js";
import { WatchedDirectory } from "../../watched-directory.js";

export const CHANNELS_DIRNAME = "channels";
export const CHANNEL_CONFIG_FILENAME = "connection.json";
export const CHANNEL_CHANGE_DEBOUNCE_MS = 50;
const CONNECTOR_NAMES: Readonly<Record<string, string>> = { discord: "Discord", slack: "Slack" };
function clampChannelLabel(raw: string): string { return raw.replace(/\s+/g, " ").trim().slice(0, 80); }
export function getAgentChannelsDir(agentDir: string): string { return join(agentDir, CHANNELS_DIRNAME); }
export function labelFor(platform: string, raw?: string): string { const clamped = raw == null ? "" : clampChannelLabel(raw); return clamped.length > 0 ? clamped : CONNECTOR_NAMES[platform] ?? platform; }

export class FileChannelStore {
  readonly dir: WatchedDirectory;
  constructor(readonly channelsDir: string) { this.dir = new WatchedDirectory(channelsDir, createDebouncePolicy(realClock, { name: "sand-channel-store-change", delayMs: CHANNEL_CHANGE_DEBOUNCE_MS })); }
  getLocation(): string { return this.dir.getLocation(); }
  setOnChange(onChange?: (() => void) | null): void { this.dir.setOnChange(onChange); }
  configPath(platform: string): string { return join(this.channelsDir, platform, CHANNEL_CONFIG_FILENAME); }
  listPlatforms(): string[] { let entries; try { entries = readdirSync(this.channelsDir, { withFileTypes: true }); } catch { return []; } return entries.filter((entry) => entry.isDirectory() && isSafeFolderId(entry.name)).map((entry) => entry.name).filter((platform) => this.readLabel(platform) != null).sort(); }
  readLabel(platform: string): string | null { let raw: string; try { raw = readFileSync(this.configPath(platform), "utf8"); } catch { return null; } let parsed: unknown; try { parsed = JSON.parse(raw) as unknown; } catch { return null; } if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null; const label = (parsed as Record<string, unknown>).label; return labelFor(platform, typeof label === "string" ? label : undefined); }
  listConnections(): Array<{ platform: string; label: string; status: "configured" }> { return this.listPlatforms().map((platform) => ({ platform, label: this.readLabel(platform) ?? platform, status: "configured" })); }
  writeMetadata(platform: string, label: string): boolean { if (!isSafeFolderId(platform)) return false; this.dir.writeFileAtomic(this.configPath(platform), `${JSON.stringify({ label: labelFor(platform, label) }, null, 2)}\n`); return true; }
  remove(platform: string): boolean { if (!isSafeFolderId(platform)) return false; const platformDir = join(this.channelsDir, platform); try { if (!statSync(platformDir).isDirectory()) return false; } catch { return false; } rmSync(platformDir, { recursive: true, force: true }); this.dir.scheduleNotify(); return true; }
}
