import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { getSandRootDir } from "../host-paths.js";
import { isSandLocalToolAction, type SandLocalToolAction } from "../../shared/local-tool-permission.js";

export const LOCAL_TOOL_PENDING_ASKS_FILENAME = "local-tool-pending-asks.json";

/** How long a question waits for an answer before it is treated as unanswered. */
export const LOCAL_TOOL_ASK_TIMEOUT_MS = 90_000;

export interface LocalToolPendingAsk {
  /** The approval id the request carries; an answer is recorded under it. */
  readonly id: string;
  readonly action: SandLocalToolAction;
  readonly target: string;
  readonly resourcePath?: string;
  readonly askedAtMs: number;
  /** Where the request came from, so the question can name it. */
  readonly origin?: string;
  /** Set by the desktop when a person answers. Absent means still asking. */
  readonly decision?: "allow" | "deny";
}

export function getLocalToolPendingAsksPath(): string {
  return join(getSandRootDir(), LOCAL_TOOL_PENDING_ASKS_FILENAME);
}

export function parsePendingAsk(value: unknown): LocalToolPendingAsk | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  if (!isSandLocalToolAction(record.action) || typeof record.target !== "string") return undefined;
  if (typeof record.askedAtMs !== "number" || !Number.isFinite(record.askedAtMs)) return undefined;
  const decision = record.decision === "allow" || record.decision === "deny" ? record.decision : undefined;
  return {
    id: record.id,
    action: record.action as SandLocalToolAction,
    target: record.target,
    askedAtMs: record.askedAtMs,
    ...(typeof record.resourcePath === "string" ? { resourcePath: record.resourcePath } : {}),
    ...(typeof record.origin === "string" ? { origin: record.origin } : {}),
    ...(decision === undefined ? {} : { decision }),
  };
}

/**
 * What a question waiting on the disk has come to.
 *
 * An approval already recorded settles it, whatever the record says - the
 * approvals file is the only thing the gate itself consults, so a decision
 * that never became an approval must not be mistaken for one. A question with
 * no answer inside its window is refused rather than left hanging: a request
 * that arrives while nobody is at the machine should end, not wait forever on
 * somebody walking past.
 */
export function pendingAskOutcome(args: {
  readonly ask: LocalToolPendingAsk | undefined;
  readonly isApproved: boolean;
  readonly nowMs: number;
  readonly timeoutMs?: number;
}): "approved" | "denied" | "waiting" | "expired" {
  if (args.isApproved) return "approved";
  if (args.ask === undefined) return "denied";
  if (args.ask.decision === "deny") return "denied";
  const timeoutMs = args.timeoutMs ?? LOCAL_TOOL_ASK_TIMEOUT_MS;
  if (args.nowMs - args.ask.askedAtMs >= timeoutMs) return "expired";
  return "waiting";
}

const writeQueues = new Map<string, Promise<unknown>>();
async function serializeWrite<T>(path: string, mutate: () => Promise<T>): Promise<T> {
  const prior = writeQueues.get(path) ?? Promise.resolve();
  const next = prior.then(mutate, mutate);
  const settled = next.then(() => undefined, () => undefined);
  writeQueues.set(path, settled);
  void settled.then(() => { if (writeQueues.get(path) === settled) writeQueues.delete(path); });
  return await next;
}

async function writeFileAtomic(path: string, data: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temp, data, "utf8");
  await fs.rename(temp, path);
}

export async function readLocalToolPendingAsks(path = getLocalToolPendingAsksPath()): Promise<LocalToolPendingAsk[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as { asks?: unknown };
    if (!Array.isArray(parsed?.asks)) return [];
    return parsed.asks.map(parsePendingAsk).filter((ask): ask is LocalToolPendingAsk => ask !== undefined);
  } catch { return []; }
}

async function persist(path: string, asks: readonly LocalToolPendingAsk[]): Promise<void> {
  if (asks.length === 0) { await fs.rm(path, { force: true }); return; }
  await writeFileAtomic(path, JSON.stringify({ asks }));
}

/** Ask, replacing any earlier question under the same id. */
export async function recordLocalToolPendingAsk(ask: LocalToolPendingAsk, path = getLocalToolPendingAsksPath()): Promise<void> {
  await serializeWrite(path, async () => {
    const existing = (await readLocalToolPendingAsks(path)).filter((entry) => entry.id !== ask.id);
    await persist(path, [...existing, ask]);
  });
}

/** Answer a question, leaving it in place so the waiting side reads the answer. */
export async function answerLocalToolPendingAsk(id: string, decision: "allow" | "deny", path = getLocalToolPendingAsksPath()): Promise<boolean> {
  return await serializeWrite(path, async () => {
    const asks = await readLocalToolPendingAsks(path);
    if (!asks.some((entry) => entry.id === id)) return false;
    await persist(path, asks.map((entry) => entry.id === id ? { ...entry, decision } : entry));
    return true;
  });
}

/** Take the question away once it has been acted on, or when it expires. */
export async function withdrawLocalToolPendingAsk(id: string, path = getLocalToolPendingAsksPath()): Promise<void> {
  await serializeWrite(path, async () => {
    await persist(path, (await readLocalToolPendingAsks(path)).filter((entry) => entry.id !== id));
  });
}

/** Drop questions nobody answered, so a stale one never surfaces late. */
export async function pruneLocalToolPendingAsks(nowMs: number, timeoutMs = LOCAL_TOOL_ASK_TIMEOUT_MS, path = getLocalToolPendingAsksPath()): Promise<void> {
  await serializeWrite(path, async () => {
    const asks = await readLocalToolPendingAsks(path);
    const live = asks.filter((ask) => nowMs - ask.askedAtMs < timeoutMs);
    if (live.length !== asks.length) await persist(path, live);
  });
}
