import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import {
  LOCAL_EXEC_DAEMON_CONNECTION_FILENAME,
  LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME,
  LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME,
  LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME
} from "../../shared/local-exec-daemon.js";

export const LOCAL_EXEC_DAEMON_LOG_FILENAME = "local-exec-daemon.log";

export interface LocalExecDaemonPaths {
  readonly connectionPath: string;
  readonly discoveryPath: string;
  readonly credentialPath: string;
  readonly logPath: string;
  readonly supervisorHeartbeatPath: string;
}

export interface LocalExecDaemonDiscovery {
  readonly pid: number;
  readonly startedAt: number;
  readonly entryRealpath?: string;
  readonly generationToken?: string;
  readonly inflightCount?: number;
}

export function resolveLocalExecDaemonPaths(dataDir: string): LocalExecDaemonPaths {
  return {
    connectionPath: join(dataDir, LOCAL_EXEC_DAEMON_CONNECTION_FILENAME),
    discoveryPath: join(dataDir, LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME),
    credentialPath: join(dataDir, LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME),
    logPath: join(dataDir, LOCAL_EXEC_DAEMON_LOG_FILENAME),
    supervisorHeartbeatPath: join(dataDir, LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function parseDiscovery(value: unknown): LocalExecDaemonDiscovery | null {
  if (!isRecord(value)) return null;
  const { pid, startedAt, entryRealpath, generationToken, inflightCount } = value;
  if (!isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  if (entryRealpath !== undefined && (typeof entryRealpath !== "string" || entryRealpath.length === 0)) return null;
  if (generationToken !== undefined && (typeof generationToken !== "string" || generationToken.length === 0)) return null;
  const identity = { pid, startedAt, ...(entryRealpath === undefined ? {} : { entryRealpath }), ...(generationToken === undefined ? {} : { generationToken }) };
  if (inflightCount === undefined) return identity;
  if (!isInteger(inflightCount) || inflightCount < 0) return null;
  return { ...identity, inflightCount };
}

function isFileMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export async function readLocalExecDaemonDiscovery(path: string): Promise<LocalExecDaemonDiscovery | null> {
  let raw: string;
  try { raw = await fs.readFile(path, "utf8"); }
  catch (error) { if (isFileMissing(error)) return null; throw error; }
  try { return parseDiscovery(JSON.parse(raw) as unknown); }
  catch { return null; }
}

export async function writeSecretJsonFile(path: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, path);
}

export function writeLocalExecDaemonConnection(connection: unknown, path: string): Promise<void> {
  return writeSecretJsonFile(path, connection);
}

export function writeLocalExecDaemonCredential(credential: unknown, path: string): Promise<void> {
  return writeSecretJsonFile(path, credential);
}

export function writeLocalExecSupervisorHeartbeat(path: string): Promise<void> {
  return writeSecretJsonFile(path, { pid: process.pid, at: Date.now() });
}

export async function removeLocalExecDaemonFile(path: string): Promise<void> {
  try { await fs.unlink(path); }
  catch (error) { if (!isFileMissing(error)) throw error; }
}

function sameDaemonGeneration(a: LocalExecDaemonDiscovery, b: LocalExecDaemonDiscovery): boolean {
  return a.pid === b.pid
    && a.startedAt === b.startedAt
    && a.entryRealpath === b.entryRealpath
    && a.generationToken === b.generationToken;
}

/** Atomically takes ownership of the current pathname, deleting only the expected generation. */
export async function removeLocalExecDaemonDiscoveryIfMatches(
  path: string,
  expected: LocalExecDaemonDiscovery,
): Promise<boolean> {
  const quarantinePath = `${path}.${process.pid}.${Date.now()}.retired`;
  try { await fs.rename(path, quarantinePath); }
  catch (error) { if (isFileMissing(error)) return false; throw error; }
  try {
    const quarantined = await readLocalExecDaemonDiscovery(quarantinePath);
    if (quarantined != null && sameDaemonGeneration(quarantined, expected)) return true;
    try { await fs.link(quarantinePath, path); }
    catch (error) { if (!isRecord(error) || error.code !== "EEXIST") throw error; }
    return false;
  } finally {
    await removeLocalExecDaemonFile(quarantinePath);
  }
}
