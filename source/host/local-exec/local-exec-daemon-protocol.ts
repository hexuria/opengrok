import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { getSandRootDir } from "../host-paths.js";
import {
  LOCAL_EXEC_DAEMON_CONNECTION_FILENAME,
  LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME,
  LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME,
  LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME
} from "../../shared/local-exec-daemon.js";
import { findSystemErrno } from "../../shared/system-errno.js";

export interface LocalExecConnection { readonly baseUrl: string; readonly token?: string; readonly headers?: Readonly<Record<string, string>>; }
export interface LocalExecDiscovery { readonly pid: number; readonly startedAt: number; readonly entryRealpath?: string; readonly generationToken?: string; readonly inflightCount?: number; }
export interface LocalExecSupervisorHeartbeat { readonly pid: number; readonly at: number; }
export interface LocalExecCredential { readonly credential: string; readonly backendUrl: string; readonly expiresAtMs?: number; }

export function getLocalExecDaemonConnectionPath(homeDir?: string): string { return join(getSandRootDir(homeDir), LOCAL_EXEC_DAEMON_CONNECTION_FILENAME); }
export function getLocalExecDaemonDiscoveryPath(homeDir?: string): string { return join(getSandRootDir(homeDir), LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME); }
export function getLocalExecDaemonCredentialPath(homeDir?: string): string { return join(getSandRootDir(homeDir), LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME); }
export function getLocalExecSupervisorHeartbeatPath(homeDir?: string): string { return join(getSandRootDir(homeDir), LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME); }

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function optionalString(value: unknown): value is string | undefined { return value === undefined || typeof value === "string"; }

export function parseLocalExecConnection(value: unknown): LocalExecConnection | null {
  if (!record(value) || typeof value.baseUrl !== "string" || value.baseUrl.length === 0 || !optionalString(value.token)) return null;
  if (value.headers !== undefined && (!record(value.headers) || Object.values(value.headers).some((item) => typeof item !== "string"))) return null;
  return { baseUrl: value.baseUrl, ...(value.token === undefined ? {} : { token: value.token }), ...(value.headers === undefined ? {} : { headers: value.headers as Record<string, string> }) };
}

export function parseLocalExecDiscovery(value: unknown): LocalExecDiscovery | null {
  if (!record(value) || !Number.isInteger(value.pid) || (value.pid as number) <= 0 || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) return null;
  if (value.inflightCount !== undefined && (!Number.isInteger(value.inflightCount) || (value.inflightCount as number) < 0)) return null;
  if (value.entryRealpath !== undefined && (typeof value.entryRealpath !== "string" || value.entryRealpath.length === 0)) return null;
  if (value.generationToken !== undefined && (typeof value.generationToken !== "string" || value.generationToken.length === 0)) return null;
  return { pid: value.pid as number, startedAt: value.startedAt, ...(value.entryRealpath === undefined ? {} : { entryRealpath: value.entryRealpath as string }), ...(value.generationToken === undefined ? {} : { generationToken: value.generationToken as string }), ...(value.inflightCount === undefined ? {} : { inflightCount: value.inflightCount as number }) };
}

export function parseLocalExecSupervisorHeartbeat(value: unknown): LocalExecSupervisorHeartbeat | null {
  return record(value) && Number.isInteger(value.pid) && (value.pid as number) > 0 && typeof value.at === "number" ? { pid: value.pid as number, at: value.at } : null;
}

export function parseLocalExecCredential(value: unknown): LocalExecCredential | null {
  if (!record(value) || typeof value.credential !== "string" || value.credential.length === 0 || typeof value.backendUrl !== "string" || value.backendUrl.length === 0) return null;
  if (value.expiresAtMs !== undefined && typeof value.expiresAtMs !== "number") return null;
  return { credential: value.credential, backendUrl: value.backendUrl, ...(value.expiresAtMs === undefined ? {} : { expiresAtMs: value.expiresAtMs }) };
}

export async function writeDaemonJsonFile(path: string, data: unknown, options: { pretty?: boolean; mode?: number } = {}): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  const serialized = JSON.stringify(data, null, options.pretty === true ? 2 : undefined);
  await fs.writeFile(tempPath, serialized, options.mode != null ? { encoding: "utf8", mode: options.mode } : "utf8");
  await fs.rename(tempPath, path);
}

async function readDaemonJsonFile<T>(path: string, parse: (value: unknown) => T | null): Promise<T | null> {
  let raw: string;
  try { raw = await fs.readFile(path, "utf8"); }
  catch (error) { if (findSystemErrno(error) === "ENOENT") return null; throw error; }
  try { return parse(JSON.parse(raw) as unknown); } catch { return null; }
}

export function writeLocalExecDaemonConnection(connection: LocalExecConnection, path = getLocalExecDaemonConnectionPath()): Promise<void> { return writeDaemonJsonFile(path, connection, { mode: 0o600 }); }
export function readLocalExecDaemonConnection(path = getLocalExecDaemonConnectionPath()): Promise<LocalExecConnection | null> { return readDaemonJsonFile(path, parseLocalExecConnection); }
export function readLocalExecDaemonDiscovery(path = getLocalExecDaemonDiscoveryPath()): Promise<LocalExecDiscovery | null> { return readDaemonJsonFile(path, parseLocalExecDiscovery); }
export function readLocalExecDaemonCredential(path = getLocalExecDaemonCredentialPath()): Promise<LocalExecCredential | null> { return readDaemonJsonFile(path, parseLocalExecCredential); }

export const NO_SUPERVISOR_HEARTBEAT = { pid: 0, at: 0 } as const;
export async function readLocalExecSupervisorHeartbeat(path = getLocalExecSupervisorHeartbeatPath()): Promise<LocalExecSupervisorHeartbeat> {
  try { return await readDaemonJsonFile(path, parseLocalExecSupervisorHeartbeat) ?? NO_SUPERVISOR_HEARTBEAT; }
  catch { return NO_SUPERVISOR_HEARTBEAT; }
}

export function writeLocalExecDaemonDiscovery(info: LocalExecDiscovery, path = getLocalExecDaemonDiscoveryPath()): Promise<void> { return writeDaemonJsonFile(path, info, { pretty: true }); }
export async function clearLocalExecDaemonDiscovery(path = getLocalExecDaemonDiscoveryPath()): Promise<void> { await fs.rm(path, { force: true }); }
export async function clearLocalExecDaemonDiscoveryIfMatches(expected: LocalExecDiscovery, path = getLocalExecDaemonDiscoveryPath()): Promise<boolean> {
  const quarantinePath = `${path}.${process.pid}.${Date.now()}.retired`;
  try { await fs.rename(path, quarantinePath); }
  catch (error) { if (findSystemErrno(error) === "ENOENT") return false; throw error; }
  try {
    const observed = await readLocalExecDaemonDiscovery(quarantinePath);
    if (observed != null
      && observed.pid === expected.pid
      && observed.startedAt === expected.startedAt
      && observed.entryRealpath === expected.entryRealpath
      && observed.generationToken === expected.generationToken) return true;
    try { await fs.link(quarantinePath, path); }
    catch (error) { if (!record(error) || error.code !== "EEXIST") throw error; }
    return false;
  } finally { await fs.rm(quarantinePath, { force: true }); }
}
