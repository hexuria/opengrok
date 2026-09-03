import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AUTOMATION_MAX_PER_AGENT,
  clampAutomationName,
  normalizeAutomationPrompt,
  slugifyAutomationName,
  type AutomationRecord,
  type AutomationRun,
} from "../host/automations/automation.js";
import { parseStoredTrigger } from "../host/automations/automation-trigger.js";
import { writeFileAtomic } from "../shared/node/atomic-write.js";
import { computeNextRunAt, describeTrigger, normalizeSchedule } from "../shared/automation-schedule.js";
import { cronTrigger, triggerSchedule, type AutomationTrigger } from "../shared/automations.js";

export const LOCAL_AUTOMATION_METHODS = new Set([
  "getAgentAutomations",
  "createAgentAutomation",
  "updateAgentAutomation",
  "deleteAgentAutomation",
  "setAgentAutomationEnabled",
  "runAgentAutomationNow",
  "listAllAutomations",
]);

const UPDATE_STATE_DESCRIPTION = [
  "Create, change, pause, resume, or delete a Grok Bot Routine (a saved prompt that fires on a schedule in this app).",
  "Never use crontab, launchd, Task Scheduler, or any OS timer — Routines are the native standing-order feature.",
  "target must be \"routine\". create needs name, prompt, and schedule or trigger. update/pause/resume/delete need id.",
].join(" ");

export const UPDATE_STATE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["target", "action"],
  properties: {
    target: { type: "string", enum: ["routine"], description: "Must be routine." },
    action: { type: "string", enum: ["create", "update", "pause", "resume", "delete"] },
    id: { type: "string", description: "Routine folder id. Required except on create." },
    name: { type: "string", description: "Required on create." },
    prompt: { type: "string", description: "What you do each time it fires, written to your future self. Required on create." },
    schedule: { type: "string", description: "5-field cron in the user's local time, or @hourly/@daily/@every 1h. Use this OR trigger, never both." },
    trigger: { type: "object", additionalProperties: true, description: "Event trigger. Prefer schedule for time-based work." },
    enabled: { type: "boolean" },
  },
} as const;

export const UPDATE_STATE_TOOL = {
  name: "update_state",
  providerIdentifier: "grok-bot",
  toolName: "update_state",
  description: UPDATE_STATE_DESCRIPTION,
  inputSchema: UPDATE_STATE_INPUT_SCHEMA,
};

type StoredAutomation = {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly trigger: AutomationTrigger;
  readonly isEnabled: boolean;
  readonly createdAt: number;
  readonly lastRunAt: number | null;
  readonly runs: readonly AutomationRun[];
};

type Store = { readonly schemaVersion: 1; readonly agents: Readonly<Record<string, readonly StoredAutomation[]>> };
const EMPTY: Store = { schemaVersion: 1, agents: {} };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function project(row: StoredAutomation, timeZone: string | undefined, filePath: string): AutomationRecord {
  const schedule = triggerSchedule(row.trigger) ?? "";
  const nextRunAt = row.isEnabled ? computeNextRunAt(schedule || "@hourly", row.lastRunAt ?? row.createdAt, timeZone) : null;
  return {
    ...row,
    raisedNotices: [],
    schedule,
    triggerDescription: describeTrigger(row.trigger),
    nextRunAt,
    runs: [...row.runs],
    filePath,
  };
}

function parseTrigger(raw: unknown, schedule?: string): AutomationTrigger | null {
  if (typeof schedule === "string" && schedule.trim().length > 0) {
    const normalized = normalizeSchedule(schedule);
    return normalized.length > 0 ? cronTrigger(normalized) : null;
  }
  return parseStoredTrigger(raw);
}

function uniqueId(name: string, existing: ReadonlySet<string>): string {
  const base = slugifyAutomationName(name);
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function renderRoutedAutomationsPrompt(automations: readonly AutomationRecord[], timeZone?: string): string {
  const zone = timeZone != null && timeZone.length > 0 ? ` (timezone ${timeZone})` : "";
  const lines = [
    "Routines are Grok Bot's native standing orders — a saved prompt plus a schedule that fires even when the user is away. They appear in the Routines panel.",
    "NEVER suggest crontab, cron, launchd, Task Scheduler, or an OS timer. If the user wants something recurring, create a Routine with the update_state tool.",
    "Be aggressive: the moment a request is recurring, time-based, or a \"let me know when\" / \"every hour\" / \"remind me\" need, create a routine instead of doing it once or handing them a script. When it is unambiguous, just create it and tell them.",
    "update_state target \"routine\", action \"create\", with a name, a prompt (what you should do each time, written to your future self), and a schedule.",
    `schedule is a 5-field cron in the user's local time${zone} ("minute hour day-of-month month day-of-week"), or @hourly / @daily / "@every 1h". Example: "0 * * * *" = top of every hour, "15 * * * *" = :15 past every hour, "0 9 * * 1-5" = 9:00am weekdays.`,
    "When they name an hour but no minute, the minute field is the minute it is right now. Use 0 only when they asked for the top of the hour.",
    "To change one: action \"update\" (id plus fields), \"pause\" / \"resume\", or \"delete\" (id).",
  ];
  if (automations.length === 0) lines.push("No routines yet.");
  else {
    lines.push("Current routines:");
    for (const automation of automations) {
      lines.push(`- ${automation.name} [${automation.isEnabled ? "enabled" : "paused"}] — ${automation.triggerDescription}; id ${automation.id}`);
    }
  }
  return lines.join("\n");
}

export function createRoutedAutomations(options: {
  readonly dataDir: string;
  readonly postEvent: (family: string, payload: unknown) => void;
  readonly now?: () => number;
  readonly timeZone?: () => string | undefined;
  readonly onFire?: (agentId: string, prompt: string, automationId: string) => Promise<void>;
}) {
  const storePath = join(options.dataDir, "inference-router-automations.json");
  const now = options.now ?? Date.now;
  const timeZone = () => options.timeZone?.();
  const firing = new Set<string>();

  const load = async (): Promise<Store> => {
    try {
      const raw = JSON.parse(await readFile(storePath, "utf8")) as unknown;
      const root = asRecord(raw);
      if (root?.schemaVersion !== 1 || asRecord(root.agents) == null) return EMPTY;
      const agents: Record<string, StoredAutomation[]> = {};
      for (const [agentId, rows] of Object.entries(root.agents as Record<string, unknown>)) {
        if (!Array.isArray(rows)) continue;
        agents[agentId] = rows.flatMap((row) => {
          const record = asRecord(row);
          if (record == null || typeof record.id !== "string" || typeof record.name !== "string" || typeof record.prompt !== "string") return [];
          const trigger = parseStoredTrigger(record.trigger) ?? (typeof record.schedule === "string" ? cronTrigger(record.schedule) : null);
          if (trigger == null) return [];
          return [{
            id: record.id,
            name: record.name,
            prompt: record.prompt,
            trigger,
            isEnabled: record.isEnabled !== false,
            createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
            lastRunAt: typeof record.lastRunAt === "number" ? record.lastRunAt : null,
            runs: Array.isArray(record.runs) ? record.runs as AutomationRun[] : [],
          }];
        });
      }
      return { schemaVersion: 1, agents };
    } catch { return EMPTY; }
  };

  const persist = async (store: Store): Promise<void> => {
    await writeFileAtomic(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  };

  const projected = (agentId: string, rows: readonly StoredAutomation[]): AutomationRecord[] =>
    rows.map((row) => project(row, timeZone(), join("inference-automations", agentId, row.id)));

  const publish = async (agentId: string, rows: readonly StoredAutomation[]) => {
    options.postEvent("automations", { agentId, automations: projected(agentId, rows) });
    return projected(agentId, rows);
  };

  const replaceAgent = async (agentId: string, rows: readonly StoredAutomation[]): Promise<AutomationRecord[]> => {
    const current = await load();
    await persist({ schemaVersion: 1, agents: { ...current.agents, [agentId]: rows } });
    return await publish(agentId, rows);
  };

  const listAgent = async (agentId: string): Promise<{ store: Store; rows: StoredAutomation[] }> => {
    const store = await load();
    return { store, rows: [...(store.agents[agentId] ?? [])] };
  };

  const executeUpdateState = async (agentId: string, args: unknown): Promise<string> => {
    const record = asRecord(args) ?? {};
    if (record.target !== "routine") return `update_state only supports target "routine" here.`;
    const action = record.action;
    const { rows } = await listAgent(agentId);
    if (action === "create") {
      if (rows.length >= AUTOMATION_MAX_PER_AGENT) return `This agent already has ${AUTOMATION_MAX_PER_AGENT} routines.`;
      const name = clampAutomationName(typeof record.name === "string" ? record.name : "");
      const prompt = normalizeAutomationPrompt(typeof record.prompt === "string" ? record.prompt : "");
      const trigger = parseTrigger(record.trigger, typeof record.schedule === "string" ? record.schedule : undefined);
      if (!name || !prompt || trigger == null) return "create needs name, prompt, and either schedule or trigger.";
      const row: StoredAutomation = {
        id: uniqueId(name, new Set(rows.map((item) => item.id))),
        name,
        prompt,
        trigger,
        isEnabled: record.enabled !== false,
        createdAt: now(),
        lastRunAt: null,
        runs: [],
      };
      const listed = await replaceAgent(agentId, [...rows, row]);
      const created = listed.find((item) => item.id === row.id);
      return created == null ? "Saved." : `Saved routine "${created.name}" (${created.triggerDescription}); id ${created.id}.`;
    }
    const id = typeof record.id === "string" ? record.id : "";
    const index = rows.findIndex((row) => row.id === id);
    if (id.length === 0 || index < 0) return `No routine with id "${id}".`;
    if (action === "delete") {
      await replaceAgent(agentId, rows.filter((row) => row.id !== id));
      return `Deleted routine ${id}.`;
    }
    if (action === "pause" || action === "resume") {
      const next = rows.map((row, rowIndex) => rowIndex === index ? { ...row, isEnabled: action === "resume" } : row);
      await replaceAgent(agentId, next);
      return action === "pause" ? `Paused routine ${id}.` : `Resumed routine ${id}.`;
    }
    if (action !== "update") return `Unknown routine action "${String(action)}".`;
    const current = rows[index]!;
    const name = typeof record.name === "string" ? clampAutomationName(record.name) : current.name;
    const prompt = typeof record.prompt === "string" ? normalizeAutomationPrompt(record.prompt) : current.prompt;
    const trigger = record.schedule != null || record.trigger != null
      ? parseTrigger(record.trigger, typeof record.schedule === "string" ? record.schedule : undefined)
      : current.trigger;
    if (!name || !prompt || trigger == null) return "update needs a usable name, prompt, and trigger.";
    const updated: StoredAutomation = {
      ...current,
      name,
      prompt,
      trigger,
      ...(typeof record.enabled === "boolean" ? { isEnabled: record.enabled } : {}),
    };
    await replaceAgent(agentId, rows.map((row, rowIndex) => rowIndex === index ? updated : row));
    return `Updated routine "${name}"; id ${id}.`;
  };

  const dispatch = async (method: string, args: unknown): Promise<unknown> => {
    const record = asRecord(args) ?? {};
    const agentId = typeof record.id === "string" ? record.id : "";
    if (method === "listAllAutomations") {
      const store = await load();
      const all = [];
      for (const [id, rows] of Object.entries(store.agents)) {
        for (const row of projected(id, rows)) all.push({ agentId: id, automation: row });
      }
      return all;
    }
    const { rows } = await listAgent(agentId);
    if (method === "getAgentAutomations") return projected(agentId, rows);
    if (method === "createAgentAutomation") {
      const spec = asRecord(record.spec) ?? record;
      const result = await executeUpdateState(agentId, {
        target: "routine",
        action: "create",
        name: spec.name,
        prompt: spec.prompt,
        ...(typeof spec.schedule === "string" ? { schedule: spec.schedule } : {}),
        ...(spec.trigger === undefined ? {} : { trigger: spec.trigger }),
        enabled: spec.isEnabled !== false,
      });
      if (!result.startsWith("Saved")) throw new Error(result);
      return projected(agentId, (await listAgent(agentId)).rows);
    }
    if (method === "updateAgentAutomation") {
      const spec = asRecord(record.spec) ?? {};
      const result = await executeUpdateState(agentId, {
        target: "routine",
        action: "update",
        id: record.automationId,
        name: spec.name,
        prompt: spec.prompt,
        ...(typeof spec.schedule === "string" ? { schedule: spec.schedule } : {}),
        ...(spec.trigger === undefined ? {} : { trigger: spec.trigger }),
        enabled: spec.isEnabled,
      });
      if (result.startsWith("No routine") || result.startsWith("update needs")) throw new Error(result);
      return projected(agentId, (await listAgent(agentId)).rows);
    }
    if (method === "deleteAgentAutomation") {
      await executeUpdateState(agentId, { target: "routine", action: "delete", id: record.automationId });
      return projected(agentId, (await listAgent(agentId)).rows);
    }
    if (method === "setAgentAutomationEnabled") {
      await executeUpdateState(agentId, {
        target: "routine",
        action: record.isEnabled === true ? "resume" : "pause",
        id: record.automationId,
      });
      return projected(agentId, (await listAgent(agentId)).rows);
    }
    if (method === "runAgentAutomationNow") {
      const id = typeof record.automationId === "string" ? record.automationId : "";
      const row = rows.find((item) => item.id === id);
      if (row == null) throw new Error(`No routine with id "${id}".`);
      await fire(agentId, row, "manual");
      return undefined;
    }
    return null;
  };

  const fire = async (agentId: string, row: StoredAutomation, trigger: "schedule" | "manual"): Promise<void> => {
    const key = `${agentId}:${row.id}`;
    if (firing.has(key) || options.onFire == null) return;
    firing.add(key);
    try {
      const startedAt = now();
      const run: AutomationRun = { id: randomUUID(), trigger, startedAt, finishedAt: null, status: "running" };
      let current = (await listAgent(agentId)).rows;
      current = current.map((item) => item.id === row.id ? { ...item, lastRunAt: startedAt, runs: [run, ...item.runs].slice(0, 20) } : item);
      await replaceAgent(agentId, current);
      const record = project(row, timeZone(), join("inference-automations", agentId, row.id));
      const prompt = [
        `[routine] "${row.name}" (id ${row.id}) ${trigger === "manual" ? "was run on demand" : `is due — ${record.triggerDescription}`}.`,
        "This is your own standing order firing, not a message the user just typed.",
        "What you saved to do each time:",
        row.prompt,
        "Carry it out now. Surface useful results naturally.",
      ].join("\n");
      await options.onFire(agentId, prompt, row.id);
      current = (await listAgent(agentId)).rows.map((item) => {
        if (item.id !== row.id) return item;
        const runs = item.runs.map((entry) => entry.id === run.id ? { ...entry, finishedAt: now(), status: "ok" as const } : entry);
        return { ...item, runs };
      });
      await replaceAgent(agentId, current);
    } catch (error) {
      const current = (await listAgent(agentId)).rows.map((item) => {
        if (item.id !== row.id) return item;
        const runs = item.runs.map((entry) => entry.status === "running"
          ? { ...entry, finishedAt: now(), status: "error" as const, detail: error instanceof Error ? error.message : String(error) }
          : entry);
        return { ...item, runs };
      });
      await replaceAgent(agentId, current);
    } finally {
      firing.delete(key);
    }
  };

  const tick = async (): Promise<void> => {
    const store = await load();
    const stamped = now();
    for (const [agentId, rows] of Object.entries(store.agents)) {
      for (const row of rows) {
        if (!row.isEnabled) continue;
        const next = computeNextRunAt(triggerSchedule(row.trigger) ?? "", row.lastRunAt ?? row.createdAt, timeZone());
        if (next != null && next <= stamped) void fire(agentId, row, "schedule");
      }
    }
  };

  const timer = setInterval(() => { void tick(); }, 15_000);
  timer.unref();

  return {
    methods: LOCAL_AUTOMATION_METHODS,
    dispatch,
    executeUpdateState,
    /** Agent deletion is the only eviction point for routine metadata. */
    deleteForAgents: async (agentIds: readonly string[]): Promise<void> => {
      const ids = new Set(agentIds);
      const current = await load();
      const remaining: Record<string, StoredAutomation[]> = {};
      for (const [agentId, rows] of Object.entries(current.agents)) {
        if (!ids.has(agentId)) remaining[agentId] = [...rows];
      }
      await persist({ schemaVersion: 1, agents: remaining });
    },
    systemPrompt: async (agentId: string): Promise<string> => {
      const { rows } = await listAgent(agentId);
      return renderRoutedAutomationsPrompt(projected(agentId, rows), timeZone());
    },
    extraTool: (agentId: string) => ({
      ...UPDATE_STATE_TOOL,
      execute: async (args: unknown) => await executeUpdateState(agentId, args),
    }),
    dispose: () => { clearInterval(timer); },
  };
}
