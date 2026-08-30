import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { getSandRootDir } from "../host-paths.js";
import { isSandLocalToolAction, type SandLocalToolAction } from "../../shared/local-tool-permission.js";

export const LOCAL_TOOL_APPROVALS_FILENAME = "local-tool-approvals.json";
export const LOCAL_TOOL_RETIREMENTS_FILENAME = "local-tool-retirements.json";

export interface LocalToolApproval {
  readonly id: string;
  readonly action: SandLocalToolAction;
  readonly target: string;
  readonly resourcePath?: string;
}

const writeQueues = new Map<string, Promise<void>>();

async function serializeWrite<T>(path: string, mutate: () => Promise<T>): Promise<T> {
  const prior = writeQueues.get(path) ?? Promise.resolve();
  const next = prior.then(mutate, mutate);
  const settled = next.then(() => undefined, () => undefined);
  writeQueues.set(path, settled);
  void settled.then(() => { if (writeQueues.get(path) === settled) writeQueues.delete(path); });
  return await next;
}

export function getLocalToolApprovalsPath(): string { return join(getSandRootDir(), LOCAL_TOOL_APPROVALS_FILENAME); }
export function getLocalToolRetirementsPath(): string { return join(getSandRootDir(), LOCAL_TOOL_RETIREMENTS_FILENAME); }

export function parseApproval(value: unknown): LocalToolApproval | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0 || !isSandLocalToolAction(record.action) || typeof record.target !== "string") return undefined;
  return { id: record.id, action: record.action, target: record.target, ...(typeof record.resourcePath === "string" ? { resourcePath: record.resourcePath } : {}) };
}

export async function readLocalToolApprovals(path = getLocalToolApprovalsPath()): Promise<Map<string, LocalToolApproval>> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as { approvals?: unknown };
    if (!Array.isArray(parsed?.approvals)) return new Map();
    const approvals = new Map<string, LocalToolApproval>();
    for (const entry of parsed.approvals) {
      const approval = parseApproval(entry);
      if (approval !== undefined) approvals.set(approval.id, approval);
    }
    return approvals;
  } catch { return new Map(); }
}

async function persist(path: string, approvals: Map<string, LocalToolApproval>): Promise<void> {
  if (approvals.size === 0) {
    await fs.rm(path, { force: true });
    return;
  }
  await writeFileAtomic(path, new Uint8Array(Buffer.from(JSON.stringify({ approvals: [...approvals.values()] }))));
}

export async function recordLocalToolApproval(
  approval: LocalToolApproval,
  path = getLocalToolApprovalsPath(),
): Promise<void> {
  await serializeWrite(path, async () => {
    const approvals = new Map(await readLocalToolApprovals(path));
    approvals.set(approval.id, approval);
    await persist(path, approvals);
  });
}

export async function clearLocalToolApprovals(path = getLocalToolApprovalsPath()): Promise<void> {
  await serializeWrite(path, async () => {
    await fs.rm(path, { force: true });
  });
}

async function readRetirements(path: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as { retiredIds?: unknown };
    return new Set(Array.isArray(parsed?.retiredIds) ? parsed.retiredIds.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}

async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, path);
}

export async function retireLocalToolApproval(approvalId: string, approvalsPath = getLocalToolApprovalsPath(), retirementsPath = getLocalToolRetirementsPath()): Promise<void> {
  await serializeWrite(retirementsPath, async () => {
    const approvals = await readLocalToolApprovals(approvalsPath);
    const retired = new Set(await readRetirements(retirementsPath));
    if (retired.has(approvalId)) return;
    retired.add(approvalId);
    for (const id of [...retired]) if (!approvals.has(id)) retired.delete(id);
    if (retired.size === 0) { await fs.rm(retirementsPath, { force: true }); return; }
    await writeFileAtomic(retirementsPath, new Uint8Array(Buffer.from(JSON.stringify({ retiredIds: [...retired] }))));
  });
}

export async function readLiveLocalToolApprovals(approvalsPath = getLocalToolApprovalsPath(), retirementsPath = getLocalToolRetirementsPath()): Promise<Map<string, LocalToolApproval>> {
  const approvals = await readLocalToolApprovals(approvalsPath);
  const retired = await readRetirements(retirementsPath);
  if (retired.size === 0) return approvals;
  const live = new Map(approvals);
  for (const id of retired) live.delete(id);
  return live;
}
