import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { errorLogTag } from "../../errors.js";
import { FLAGS, type FeatureFlagName } from "./experiment-config.ported.js";
import { reportExperimentsDiagnostic } from "./experiments-diagnostics.js";
export const FEATURE_FLAG_OVERRIDES_FILENAME = "sand-feature-flag-overrides.json";
export const FEATURE_FLAG_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1_000;
export function isFlagName(name: string): name is FeatureFlagName { return Object.hasOwn(FLAGS, name); }
interface Entry { value: boolean; expiresAtMs: number; }
export class SandFeatureFlagOverrideStore {
  private readonly overrides = new Map<FeatureFlagName, Entry>();
  constructor(private readonly getCacheDir: () => string, private readonly now: () => number = Date.now) {}
  getOverridesPath(): string { return join(this.getCacheDir(), FEATURE_FLAG_OVERRIDES_FILENAME); }
  hydrateFromDisk(): void { try { const path = this.getOverridesPath(); if (!existsSync(path)) return; const parsed = JSON.parse(readFileSync(path, "utf8")) as { overrides?: unknown }; if (typeof parsed.overrides !== "object" || parsed.overrides == null) return; const now = this.now(); for (const [name, raw] of Object.entries(parsed.overrides)) { if (!isFlagName(name) || typeof raw !== "object" || raw == null) continue; const entry = raw as Record<string, unknown>; if (typeof entry.value !== "boolean" || typeof entry.expiresAtMs !== "number" || entry.expiresAtMs <= now) continue; this.overrides.set(name, { value: entry.value, expiresAtMs: entry.expiresAtMs }); } } catch (error) { reportExperimentsDiagnostic({ kind: "overrides_load_failed", errorClass: errorLogTag(error) }); } }
  async persist(): Promise<void> { try { const path = this.getOverridesPath(); await mkdir(dirname(path), { recursive: true }); const overrides: Record<string, Entry> = {}; for (const [name, entry] of this.overrides) overrides[name] = entry; const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify({ overrides }), "utf8"); await rename(temp, path); } catch (error) { reportExperimentsDiagnostic({ kind: "overrides_persist_failed", errorClass: errorLogTag(error) }); } }
  read(name: FeatureFlagName): boolean | undefined { const entry = this.overrides.get(name); if (entry == null) return undefined; if (entry.expiresAtMs <= this.now()) { this.overrides.delete(name); return undefined; } return entry.value; }
  activeOverrides(): Map<FeatureFlagName, boolean> { const result = new Map<FeatureFlagName, boolean>(); const now = this.now(); for (const [name, entry] of this.overrides) if (entry.expiresAtMs > now) result.set(name, entry.value); return result; }
  activeRecord(): Partial<Record<FeatureFlagName, boolean>> { return Object.fromEntries(this.activeOverrides()) as Partial<Record<FeatureFlagName, boolean>>; }
  get size(): number { return this.overrides.size; }
  set(name: string, value: boolean): boolean { if (!isFlagName(name)) return false; this.overrides.set(name, { value, expiresAtMs: this.now() + FEATURE_FLAG_OVERRIDE_TTL_MS }); return true; }
  clear(name: FeatureFlagName): boolean { return this.overrides.delete(name); }
  clearAll(): void { this.overrides.clear(); }
  setAllToBundledDefaults(): void { const expiresAtMs = this.now() + FEATURE_FLAG_OVERRIDE_TTL_MS; for (const name of Object.keys(FLAGS)) if (isFlagName(name)) this.overrides.set(name, { value: FLAGS[name]?.default ?? false, expiresAtMs }); }
  replaceAll(overrides: Readonly<Record<string, boolean>>): void { const expiresAtMs = this.now() + FEATURE_FLAG_OVERRIDE_TTL_MS; this.overrides.clear(); for (const [name, value] of Object.entries(overrides)) if (typeof value === "boolean" && isFlagName(name)) this.overrides.set(name, { value, expiresAtMs }); }
}
