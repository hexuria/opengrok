import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDebouncePolicy, realClock } from "../../internal/scheduling.js";
import { automationAnchor, computeNextRunAt, describeTrigger, normalizeSchedule } from "../../shared/automation-schedule.js";
import { cronTrigger, triggerCronSchedules, triggerFromList, triggerList, triggerSchedule, type AutomationTrigger } from "../../shared/automations.js";
import { isSafeFolderId } from "../storage/folder-id.js";
import { WatchedDirectory } from "../watched-directory.js";
import { AUTOMATION_MAX_PER_AGENT, AUTOMATION_MAX_RUN_DETAIL_LENGTH, AUTOMATION_MAX_RUN_HISTORY, MAX_EVENTS_IN_AUTOMATION_WAKE, clampAutomationName, createAutomationRunId, normalizeAutomationPrompt, slugifyAutomationName, type AutomationConfig, type AutomationRecord, type AutomationRun, type AutomationRunStatus, type AutomationRunTrigger, type AutomationSpec } from "./automation.js";
import { parseStoredTrigger, serializeStoredTrigger } from "./automation-trigger.js";
import { isRoutineNoticeId } from "./routine-notices.js";

export const AUTOMATIONS_DIRNAME = "automations";
export const CONFIG_FILENAME = "automation.json";
export const RUNS_FILENAME = "runs.json";
export const AUTOMATION_CHANGE_DEBOUNCE_MS = 50;

export type AutomationDefinitionInspectionState = "agent_missing" | "dir_missing" | "valid" | "configs_invalid" | "dir_empty";
export interface AutomationDefinitionInspection { state: AutomationDefinitionInspectionState; validDefinitionCount: number }

export function getAgentAutomationsDir(agentDir: string): string { return join(agentDir, AUTOMATIONS_DIRNAME); }
export function inspectAgentAutomationDefinitions(agentDir: string): AutomationDefinitionInspection {
  try { if (!statSync(agentDir).isDirectory()) return { state: "agent_missing", validDefinitionCount: 0 }; } catch { return { state: "agent_missing", validDefinitionCount: 0 }; }
  const automationsDir = getAgentAutomationsDir(agentDir); let entries;
  try { entries = readdirSync(automationsDir, { withFileTypes: true }); } catch { return { state: "dir_missing", validDefinitionCount: 0 }; }
  let candidateCount = 0, validDefinitionCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeFolderId(entry.name)) continue;
    candidateCount += 1; const configPath = join(automationsDir, entry.name, CONFIG_FILENAME); let raw: string;
    try { raw = readFileSync(configPath, "utf8"); } catch { continue; }
    let fallbackCreatedAt = Date.now(); try { const stats = statSync(configPath); fallbackCreatedAt = Math.floor(stats.birthtimeMs || stats.mtimeMs); } catch {}
    if (parseStoredConfig(raw, fallbackCreatedAt) != null) validDefinitionCount += 1;
  }
  if (validDefinitionCount > 0) return { state: "valid", validDefinitionCount };
  return { state: candidateCount > 0 ? "configs_invalid" : "dir_empty", validDefinitionCount: 0 };
}
export function agentHasAutomations(agentDir: string): boolean { return inspectAgentAutomationDefinitions(agentDir).validDefinitionCount > 0; }

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value != null && !Array.isArray(value); }
export function parseStoredConfigTrigger(parsed: Record<string, unknown>): AutomationTrigger | null { if (parsed.trigger != null) { const trigger = parseStoredTrigger(parsed.trigger); if (trigger != null) return trigger; } const schedule = typeof parsed.schedule === "string" ? normalizeSchedule(parsed.schedule) : ""; return schedule ? cronTrigger(schedule) : null; }
export function parseRaisedNotices(value: unknown): string[] { if (!Array.isArray(value)) return []; const ids: string[] = []; for (const entry of value) { if (typeof entry !== "string") continue; const id = entry.trim(); if (id && !ids.includes(id) && isRoutineNoticeId(id)) ids.push(id); } return ids; }
export function parseStoredConfig(raw: string, fallbackCreatedAt: number): AutomationConfig | null {
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return null; } if (!object(parsed)) return null;
  const name = typeof parsed.name === "string" ? clampAutomationName(parsed.name) : "", prompt = typeof parsed.prompt === "string" ? normalizeAutomationPrompt(parsed.prompt) : "", trigger = parseStoredConfigTrigger(parsed); if (!name || !prompt || trigger == null) return null;
  const authored = typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) ? parsed.createdAt : fallbackCreatedAt;
  return { name, prompt, trigger, isEnabled: parsed.enabled !== false, createdAt: Math.min(authored, fallbackCreatedAt), lastRunAt: typeof parsed.lastRunAt === "number" && Number.isFinite(parsed.lastRunAt) ? parsed.lastRunAt : null, raisedNotices: parseRaisedNotices(parsed.raisedNotices) };
}
export function serializeConfig(config: AutomationConfig): string { const schedule = triggerSchedule(config.trigger); return `${JSON.stringify({ name: config.name, prompt: config.prompt, ...(schedule != null ? { schedule } : {}), ...(config.trigger.type === "cron" ? {} : { trigger: serializeStoredTrigger(config.trigger) }), enabled: config.isEnabled, createdAt: config.createdAt, lastRunAt: config.lastRunAt, ...(config.raisedNotices.length ? { raisedNotices: config.raisedNotices } : {}) }, null, 2)}\n`; }
export function clampRunDetail(detail: unknown): string | undefined { if (typeof detail !== "string") return undefined; const value = detail.trim(); return value ? value.slice(0, AUTOMATION_MAX_RUN_DETAIL_LENGTH) : undefined; }
export function clampCoalescedRunIds(value: unknown): string[] | undefined { if (!Array.isArray(value)) return undefined; const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, MAX_EVENTS_IN_AUTOMATION_WAKE); return ids.length ? ids : undefined; }
export function parseStoredRun(entry: unknown): AutomationRun | null { if (!object(entry)) return null; const id = typeof entry.id === "string" && entry.id ? entry.id : null, startedAt = typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt) ? entry.startedAt : null; if (id == null || startedAt == null) return null; const status: AutomationRunStatus = entry.status === "error" || entry.status === "running" ? entry.status : "ok", trigger: AutomationRunTrigger = entry.trigger === "manual" || entry.trigger === "event" ? entry.trigger : "schedule", detail = clampRunDetail(entry.detail), event = clampRunDetail(entry.event), coalescedRunIds = clampCoalescedRunIds(entry.coalescedRunIds); return { id, trigger, startedAt, finishedAt: typeof entry.finishedAt === "number" && Number.isFinite(entry.finishedAt) ? entry.finishedAt : null, status, ...(detail ? { detail } : {}), ...(event ? { event } : {}), ...(coalescedRunIds ? { coalescedRunIds } : {}) }; }

export class FileAutomationStore {
  readonly dir: WatchedDirectory;
  constructor(readonly automationsDir: string, readonly resolveUserTimeZone: () => string | undefined = () => undefined) { this.dir = new WatchedDirectory(automationsDir, createDebouncePolicy(realClock, { name: "sand-automation-store-change", delayMs: AUTOMATION_CHANGE_DEBOUNCE_MS })); }
  getLocation(): string { return this.dir.getLocation(); } setOnChange(onChange?: (() => void) | null): void { this.dir.setOnChange(onChange); } configPath(id: string): string { return join(this.automationsDir, id, CONFIG_FILENAME); } runsPath(id: string): string { return join(this.automationsDir, id, RUNS_FILENAME); }
  toRecord(id: string, config: AutomationConfig, deriveNextRunAt: boolean): AutomationRecord { return { id, ...config, schedule: triggerSchedule(config.trigger) ?? "", triggerDescription: describeTrigger(config.trigger), nextRunAt: deriveNextRunAt && config.isEnabled ? this.earliestNextRunAt(config) : null, runs: this.readRuns(id), filePath: this.configPath(id) }; }
  earliestNextRunAt(config: AutomationConfig): number | null { const anchor = automationAnchor(config), timeZone = this.resolveUserTimeZone(); let earliest: number | null = null; for (const schedule of triggerCronSchedules(config.trigger)) { const next = computeNextRunAt(schedule, anchor, timeZone); if (next != null && (earliest == null || next < earliest)) earliest = next; } return earliest; }
  readRuns(id: string): AutomationRun[] { let parsed: unknown; try { parsed = JSON.parse(readFileSync(this.runsPath(id), "utf8")); } catch { return []; } if (!Array.isArray(parsed)) return []; return parsed.flatMap((entry) => { const run = parseStoredRun(entry); return run == null ? [] : [run]; }).sort((a, b) => b.startedAt - a.startedAt).slice(0, AUTOMATION_MAX_RUN_HISTORY); }
  writeRuns(id: string, runs: readonly AutomationRun[]): void { this.dir.writeFileAtomic(this.runsPath(id), `${JSON.stringify(runs, null, 2)}\n`); }
  readConfig(id: string): AutomationConfig | null { const file = this.configPath(id); let raw: string; try { raw = readFileSync(file, "utf8"); } catch { return null; } let fallback = Date.now(); try { const stats = statSync(file); fallback = Math.floor(stats.birthtimeMs || stats.mtimeMs); } catch {} return parseStoredConfig(raw, fallback); }
  writeConfig(id: string, config: AutomationConfig): void { this.dir.writeFileAtomic(this.configPath(id), serializeConfig(config)); }
  listIds(): string[] { return this.dir.listSubdirectoryNames(); }
  list(): AutomationRecord[] { return this.#list(true).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.createdAt - b.createdAt); }
  listDefinitions(): AutomationRecord[] { return this.#list(false).sort((a, b) => a.createdAt - b.createdAt); }
  #list(derive: boolean): AutomationRecord[] { return this.listIds().flatMap((id) => { const config = this.readConfig(id); return config == null ? [] : [this.toRecord(id, config, derive)]; }); }
  get(id: string): AutomationRecord | null { if (!isSafeFolderId(id)) return null; const config = this.readConfig(id); return config == null ? null : this.toRecord(id, config, true); }
  count(): number { return this.listIds().filter((id) => this.readConfig(id) != null).length; }
  uniqueId(name: string): string { const base = slugifyAutomationName(name), existing = new Set(this.listIds()); if (!existing.has(base)) return base; for (let suffix = 2; suffix < 1_000; suffix += 1) { const candidate = `${base}-${suffix}`; if (!existing.has(candidate)) return candidate; } return `${base}-${Date.now()}`; }
  normalizeSpecTrigger(trigger: AutomationTrigger): AutomationTrigger | null { const members: ReturnType<typeof triggerList> = []; for (const member of triggerList(trigger)) { if (member.type !== "cron") members.push(member); else { const schedule = normalizeSchedule(member.schedule); if (!schedule) return null; members.push(cronTrigger(schedule)); } } const normalized = triggerFromList(members); return normalized == null || normalized.type === "cron" ? normalized : parseStoredTrigger(serializeStoredTrigger(normalized)); }
  upsert(spec: AutomationSpec, createdAt = Date.now()): AutomationRecord | null { const name = clampAutomationName(spec.name), prompt = normalizeAutomationPrompt(spec.prompt), trigger = this.normalizeSpecTrigger(spec.trigger); if (!name || !prompt || trigger == null || this.count() >= AUTOMATION_MAX_PER_AGENT) return null; const id = this.uniqueId(name), config: AutomationConfig = { name, prompt, trigger, isEnabled: spec.isEnabled ?? true, createdAt, lastRunAt: null, raisedNotices: [] }; this.writeConfig(id, config); return this.toRecord(id, config, true); }
  update(id: string, spec: AutomationSpec): AutomationRecord | null { if (!isSafeFolderId(id)) return null; const current = this.readConfig(id), name = clampAutomationName(spec.name), prompt = normalizeAutomationPrompt(spec.prompt), trigger = this.normalizeSpecTrigger(spec.trigger); if (current == null || !name || !prompt || trigger == null) return null; const config = { ...current, name, prompt, trigger, isEnabled: spec.isEnabled ?? current.isEnabled }; this.writeConfig(id, config); return this.toRecord(id, config, true); }
  markNoticeRaised(id: string, notice: string): AutomationRecord | null { if (!isSafeFolderId(id) || !isRoutineNoticeId(notice)) return null; const current = this.readConfig(id); if (current == null) return null; const config = current.raisedNotices.includes(notice) ? current : { ...current, raisedNotices: [...current.raisedNotices, notice] }; if (config !== current) this.writeConfig(id, config); return this.toRecord(id, config, true); }
  setEnabled(id: string, isEnabled: boolean): AutomationRecord | null { if (!isSafeFolderId(id)) return null; const current = this.readConfig(id); if (current == null) return null; const config = current.isEnabled === isEnabled ? current : { ...current, isEnabled }; if (config !== current) this.writeConfig(id, config); return this.toRecord(id, config, true); }
  recordRun(id: string, at = Date.now()): AutomationRecord | null { return this.recordRunWith(id, at, true); } recordRunDefinition(id: string, at = Date.now()): AutomationRecord | null { return this.recordRunWith(id, at, false); }
  recordRunWith(id: string, at: number, derive: boolean): AutomationRecord | null { if (!isSafeFolderId(id)) return null; const current = this.readConfig(id); if (current == null) return null; const config = { ...current, lastRunAt: at }; this.writeConfig(id, config); return this.toRecord(id, config, derive); }
  beginRun({ id, trigger, at = Date.now(), event, runId = createAutomationRunId(), coalescedRunIds }: { id: string; trigger: AutomationRunTrigger; at?: number; event?: string; runId?: string; coalescedRunIds?: string[] }): AutomationRun | null { if (!isSafeFolderId(id) || this.readConfig(id) == null) return null; const runs = this.readRuns(id), existing = runs.find((run) => run.id === runId); if (existing != null) return existing; const eventSummary = clampRunDetail(event), absorbed = clampCoalescedRunIds(coalescedRunIds), run: AutomationRun = { id: runId, trigger, startedAt: at, finishedAt: null, status: "running", ...(eventSummary ? { event: eventSummary } : {}), ...(absorbed ? { coalescedRunIds: absorbed } : {}) }; this.writeRuns(id, [run, ...runs].slice(0, AUTOMATION_MAX_RUN_HISTORY)); return run; }
  finishRun(id: string, runId: string, status: Exclude<AutomationRunStatus, "running">, at = Date.now(), detail?: string): AutomationRecord | null { return this.finishRunWith(id, runId, status, at, detail, true); }
  finishRunDefinition({ id, runId, status, at = Date.now(), detail }: { id: string; runId: string; status: Exclude<AutomationRunStatus, "running">; at?: number; detail?: string }): AutomationRecord | null { return this.finishRunWith(id, runId, status, at, detail, false); }
  finishRunWith(id: string, runId: string, status: Exclude<AutomationRunStatus, "running">, at: number, detail: string | undefined, derive: boolean): AutomationRecord | null { if (!isSafeFolderId(id)) return null; const config = this.readConfig(id); if (config == null) return null; const runs = this.readRuns(id), index = runs.findIndex((run) => run.id === runId); if (index < 0) return this.toRecord(id, config, derive); const value = runs[index] as AutomationRun, clamped = clampRunDetail(detail); runs[index] = { ...value, finishedAt: at, status, ...(clamped ? { detail: clamped } : {}) }; this.writeRuns(id, runs); return this.toRecord(id, config, derive); }
  remove(id: string): boolean { if (!isSafeFolderId(id)) return false; const folder = join(this.automationsDir, id); try { if (!statSync(folder).isDirectory()) return false; } catch { return false; } rmSync(folder, { recursive: true, force: true }); this.dir.scheduleNotify(); return true; }
}
