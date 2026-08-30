import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { AGENT_STORE_SYNC_DIR_NAME, ensureSecureDirectoryChain } from "./paths.js";
import { writeLockFileExclusive } from "./secure-open.js";
import { normalizeRelPath } from "./safe-paths.js";

const AGENT_STORE_PATH_SYNC_REQUESTS_DIR_NAME = "path-sync-requests";
const PATH_SYNC_REQUEST_STALE_MS = 60_000;
export const PATH_SYNC_REQUEST_POLL_MS = 250;
export const PATH_SYNC_REQUEST_WAIT_POLL_MS = 50;
const PRIVATE_FILE_MODE = 0o600;
const REQUEST_VERSION = 1;

interface PathSyncRequest {
  readonly v: typeof REQUEST_VERSION;
  readonly id: string;
  readonly relPaths: string[];
  readonly createdAtMs: number;
}

interface PathSyncRequestArgs {
  readonly filesDir: string;
  readonly now?: () => number;
  readonly staleMs?: number;
}

function pathSyncRequestsDirForFilesDir(filesDir: string): string {
  return path.join(path.dirname(path.resolve(filesDir)), AGENT_STORE_SYNC_DIR_NAME, AGENT_STORE_PATH_SYNC_REQUESTS_DIR_NAME);
}

function requestPath(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

function tryNormalizeRelPaths(relPaths: readonly unknown[]): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of relPaths) {
    let canonical: string;
    try {
      canonical = normalizeRelPath(raw);
    } catch {
      return undefined;
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

export async function enqueuePathSyncRequest(args: { readonly filesDir: string; readonly relPaths: readonly unknown[]; readonly now?: () => number }): Promise<string | undefined> {
  const relPaths = tryNormalizeRelPaths(args.relPaths);
  if (relPaths === undefined || relPaths.length === 0) {
    return undefined;
  }
  const dir = pathSyncRequestsDirForFilesDir(args.filesDir);
  try {
    ensureSecureDirectoryChain(dir);
  } catch {
    return undefined;
  }
  const id = crypto.randomBytes(16).toString("hex");
  const body: PathSyncRequest = {
    v: REQUEST_VERSION,
    id,
    relPaths,
    createdAtMs: (args.now ?? Date.now)(),
  };
  const target = requestPath(dir, id);
  try {
    await writeLockFileExclusive(target, `${JSON.stringify(body)}\n`, PRIVATE_FILE_MODE);
  } catch {
    return undefined;
  }
  return id;
}

function parseRequest(raw: string): PathSyncRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as { readonly v?: unknown; readonly id?: unknown; readonly relPaths?: unknown; readonly createdAtMs?: unknown };
  if (record.v !== REQUEST_VERSION) {
    return undefined;
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    return undefined;
  }
  if (!Array.isArray(record.relPaths)) {
    return undefined;
  }
  if (typeof record.createdAtMs !== "number" || !Number.isFinite(record.createdAtMs)) {
    return undefined;
  }
  const relPaths = tryNormalizeRelPaths(record.relPaths.filter(value => typeof value === "string"));
  if (relPaths === undefined || relPaths.length === 0) {
    return undefined;
  }
  return {
    v: REQUEST_VERSION,
    id: record.id,
    relPaths,
    createdAtMs: record.createdAtMs,
  };
}

export function listPathSyncRequests(args: PathSyncRequestArgs): PathSyncRequest[] {
  const dir = pathSyncRequestsDirForFilesDir(args.filesDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const now = (args.now ?? Date.now)();
  const staleMs = args.staleMs ?? PATH_SYNC_REQUEST_STALE_MS;
  const out: PathSyncRequest[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      try {
        fs.unlinkSync(full);
      } catch {
      }
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const request = parseRequest(raw);
    if (request === undefined) {
      try {
        fs.unlinkSync(full);
      } catch {
      }
      continue;
    }
    if (now - request.createdAtMs > staleMs) {
      try {
        fs.unlinkSync(full);
      } catch {
      }
      continue;
    }
    out.push(request);
  }
  return out;
}

type PathSyncRequestPresence = "acked" | "pending" | "stale";

function inspectPathSyncRequest(args: PathSyncRequestArgs & { readonly requestId: string }): PathSyncRequestPresence {
  const dir = pathSyncRequestsDirForFilesDir(args.filesDir);
  const full = requestPath(dir, args.requestId);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "acked";
    }
    return "pending";
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    try {
      fs.unlinkSync(full);
    } catch {
    }
    return "stale";
  }
  let raw: string;
  try {
    raw = fs.readFileSync(full, "utf8");
  } catch {
    return "pending";
  }
  const request = parseRequest(raw);
  if (request === undefined) {
    try {
      fs.unlinkSync(full);
    } catch {
    }
    return "stale";
  }
  const now = (args.now ?? Date.now)();
  const staleMs = args.staleMs ?? PATH_SYNC_REQUEST_STALE_MS;
  if (now - request.createdAtMs > staleMs) {
    try {
      fs.unlinkSync(full);
    } catch {
    }
    return "stale";
  }
  return "pending";
}

export function ackPathSyncRequests(args: { readonly filesDir: string; readonly requestIds: readonly string[] }): void {
  const dir = pathSyncRequestsDirForFilesDir(args.filesDir);
  for (const id of args.requestIds) {
    if (!/^[0-9a-f]+$/i.test(id)) {
      continue;
    }
    try {
      fs.unlinkSync(requestPath(dir, id));
    } catch {
    }
  }
}

export async function waitForPathSyncRequestAck(args: {
  readonly filesDir: string;
  readonly requestId: string;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly staleMs?: number;
  readonly shouldAbort?: () => boolean;
  readonly delay?: (ms: number) => Promise<unknown>;
}): Promise<"acked" | "stale" | "aborted"> {
  const pollMs = args.pollMs ?? PATH_SYNC_REQUEST_WAIT_POLL_MS;
  const delay = args.delay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (;;) {
    const presence = inspectPathSyncRequest(args);
    if (presence === "acked") {
      return "acked";
    }
    if (presence === "stale") {
      return "stale";
    }
    if (args.shouldAbort?.() === true) {
      return "aborted";
    }
    await delay(pollMs);
  }
}
