import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getHostSecretsPath } from "./host-paths.js";

let machineIdCache: string | undefined;

export async function getOrCreateHostMachineId(path = getHostSecretsPath()): Promise<string> {
  if (machineIdCache != null) return machineIdCache;
  const existing = await readMachineId(path);
  if (existing != null) { machineIdCache = existing; return existing; }
  const machineId = randomUUID();
  await writeMachineId(path, machineId);
  machineIdCache = machineId;
  return machineId;
}

export async function readMachineId(path: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
    const machineId = (parsed as Record<string, unknown>).machineId;
    return typeof machineId === "string" && machineId.length > 0 ? machineId : null;
  } catch { return null; }
}

export async function writeMachineId(path: string, machineId: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify({ machineId }, null, 2), "utf8");
  await rename(tempPath, path);
}

/** Test-only reset; production never clears the process-global machine identity. */
export function clearHostMachineIdCacheForTests(): void { machineIdCache = undefined; }
