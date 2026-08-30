import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { findSystemErrno } from "../../../shared/system-errno.js";
import { invariant } from "../../../shared/invariant.js";
import { getBoxStoreBackendPolicy } from "../../box/box-store-backend-policy.js";
import {
  AgentStoreMutableWriteEtags,
  createAgentStoreClient,
  fetchAgentStoreObjectFromUrl,
  fetchAgentStoreObjectToFileFromUrl,
  getAgentStoreObject,
  getAgentStoreObjectToFile,
  listAgentStoreObjects,
  presignAgentStoreReadBatch,
  putAgentStoreObject,
  putAgentStoreObjectContentAddressed,
  putAgentStoreObjectFromFile,
  type AgentStoreClient,
  type AgentStoreClientDependencies,
} from "./agent-store-sand-files.js";
import { BoxStoreCanonicalWriteConflictError } from "./object-store-port.js";
import {
  SandBoxStoreServiceProvider,
  type SandBoxStoreServiceDependencies,
} from "./sand-box-store-files.js";
import { SandBoxStoreSyncError } from "./box-store-sync-error.js";

export interface BoxObjectStore {
  get(key: string): Promise<Uint8Array | null>;
  put(
    key: string,
    bytes: Uint8Array,
    options?: { readonly contentAddressed?: boolean },
  ): Promise<void>;
  getToFile?(
    key: string,
    destPath: string,
    options?: { readonly maxBytes?: number },
  ): Promise<number | null>;
  putFromFile?(key: string, srcPath: string, sha: string, size: number): Promise<void>;
  prefetchReads?(keys: readonly string[]): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface BoxObjectStoreProvider {
  forStore(storeId: string): BoxObjectStore;
}

const PREFETCHED_READ_FRESHNESS_MARGIN_MS = 30_000;

export class AgentStoreObjectStoreProvider implements BoxObjectStoreProvider {
  private clientInstance: AgentStoreClient | undefined;
  private readonly mutableEtags = new AgentStoreMutableWriteEtags();

  constructor(readonly deps: AgentStoreClientDependencies) {
    this.clientInstance = deps.client;
  }

  forStore(storeId: string): AgentStoreObjectStore {
    return new AgentStoreObjectStore(this.client(), storeId, this.mutableEtags);
  }

  private client(): AgentStoreClient {
    this.clientInstance ??= createAgentStoreClient({
      getAccessToken: this.deps.getAccessToken ?? (() => {
        invariant(false, "AgentStoreObjectStore: no getAccessToken provided");
      }),
      getMachineId: this.deps.getMachineId ?? (() => {
        invariant(false, "AgentStoreObjectStore: no getMachineId provided");
      }),
    });
    return this.clientInstance;
  }
}

export class AgentStoreObjectStore implements BoxObjectStore {
  private readonly prefetchedReads = new Map<
    string,
    { readonly url: string; readonly expiresAtMs: number }
  >();

  constructor(
    readonly client: AgentStoreClient,
    readonly storeId: string,
    readonly mutableEtags: AgentStoreMutableWriteEtags,
  ) {}

  async prefetchReads(keys: readonly string[]): Promise<void> {
    const presigned = await presignAgentStoreReadBatch(this.client, this.storeId, keys);
    for (const [key, url] of presigned) this.prefetchedReads.set(key, url);
  }

  private takePrefetchedRead(
    key: string,
  ): { readonly url: string; readonly expiresAtMs: number } | undefined {
    const cached = this.prefetchedReads.get(key);
    if (cached === undefined) return undefined;
    this.prefetchedReads.delete(key);
    return cached.expiresAtMs - Date.now() > PREFETCHED_READ_FRESHNESS_MARGIN_MS
      ? cached
      : undefined;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const cached = this.takePrefetchedRead(key);
    if (cached !== undefined) {
      try {
        const viaCache = await fetchAgentStoreObjectFromUrl(cached.url, key);
        if (viaCache !== null) return viaCache;
      } catch {}
    }
    return getAgentStoreObject(this.client, this.storeId, key);
  }

  async put(
    key: string,
    bytes: Uint8Array,
    options?: { readonly contentAddressed?: boolean },
  ): Promise<void> {
    if (options?.contentAddressed === true) {
      await putAgentStoreObjectContentAddressed({
        client: this.client,
        sourceId: this.storeId,
        relPath: key,
        data: bytes,
      });
      return;
    }
    const result = await putAgentStoreObject({
      client: this.client,
      sourceId: this.storeId,
      relPath: key,
      data: bytes,
      etags: this.mutableEtags,
    });
    if (result.outcome === "conflict") {
      throw new BoxStoreCanonicalWriteConflictError({
        key,
        conflictRelPath: result.conflictRelPath,
        baseEtag: result.baseEtag,
        baselineSource: result.baselineSource,
      });
    }
  }

  async getToFile(
    key: string,
    destPath: string,
    options?: { readonly maxBytes?: number },
  ): Promise<number | null> {
    const cached = this.takePrefetchedRead(key);
    if (cached !== undefined) {
      try {
        const viaCache = await fetchAgentStoreObjectToFileFromUrl(
          cached.url,
          key,
          destPath,
          options?.maxBytes,
        );
        if (viaCache !== null) return viaCache;
      } catch {}
    }
    return getAgentStoreObjectToFile(
      this.client,
      this.storeId,
      key,
      destPath,
      options?.maxBytes,
    );
  }

  putFromFile(key: string, srcPath: string, sha: string, size: number): Promise<void> {
    return putAgentStoreObjectFromFile({
      client: this.client,
      sourceId: this.storeId,
      relPath: key,
      srcPath,
      sha,
      size,
    });
  }

  list(prefix: string): Promise<string[]> {
    return listAgentStoreObjects(this.client, this.storeId, prefix);
  }

  async delete(key: string): Promise<void> {
    invariant(false, () => `AgentStoreObjectStore is append-only; cannot delete ${key}`);
  }
}

export class LocalFsObjectStoreProvider implements BoxObjectStoreProvider {
  constructor(readonly baseDir: string) {}

  forStore(storeId: string): LocalFsObjectStore {
    return new LocalFsObjectStore(join(this.baseDir, storeId));
  }
}

export class LocalFsObjectStore implements BoxObjectStore {
  constructor(readonly root: string) {}

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if (findSystemErrno(error) === "ENOENT") return null;
      throw error;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const dest = this.pathFor(key);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  }

  async getToFile(
    key: string,
    destPath: string,
    options?: { readonly maxBytes?: number },
  ): Promise<number | null> {
    const src = this.pathFor(key);
    let size: number;
    try {
      size = (await stat(src)).size;
    } catch (error) {
      if (findSystemErrno(error) === "ENOENT") return null;
      throw error;
    }
    if (options?.maxBytes !== undefined && size > options.maxBytes) {
      throw new SandBoxStoreSyncError(
        `object ${key} is ${size}B over the ${options.maxBytes}B cap`,
      );
    }
    await mkdir(dirname(destPath), { recursive: true });
    await pipeline(createReadStream(src), createWriteStream(destPath));
    return size;
  }

  async putFromFile(key: string, srcPath: string, _sha: string, _size: number): Promise<void> {
    const dest = this.pathFor(key);
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(createReadStream(srcPath), createWriteStream(dest));
  }

  async list(prefix: string): Promise<string[]> {
    const found: string[] = [];
    await walkFiles(this.root, found);
    return found
      .map((absolutePath) => relative(this.root, absolutePath).split(sep).join("/"))
      .filter((key) => isUnderPrefix(key, prefix))
      .sort();
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (error) {
      if (findSystemErrno(error) !== "ENOENT") throw error;
    }
  }

  pathFor(key: string): string {
    return join(this.root, ...key.split("/"));
  }
}

export function resolveBoxObjectStoreProvider(deps: {
  readonly env?: NodeJS.ProcessEnv;
  readonly agentStore: AgentStoreClientDependencies;
}): BoxObjectStoreProvider {
  const policy = getBoxStoreBackendPolicy(deps.env);
  switch (policy.kind) {
    case "local-fs":
      return new LocalFsObjectStoreProvider(policy.localDir ?? "");
    case "sand-box-store-v2": {
      invariant(
        deps.agentStore.getAccessToken !== undefined && deps.agentStore.getMachineId !== undefined,
        "sand-box-store v2 selected but no backend auth was provided",
      );
      const serviceDeps: SandBoxStoreServiceDependencies = {
        getAccessToken: deps.agentStore.getAccessToken,
        getMachineId: deps.agentStore.getMachineId,
      };
      return new SandBoxStoreServiceProvider(serviceDeps);
    }
    case "agent-store":
      return new AgentStoreObjectStoreProvider(deps.agentStore);
  }
}

export function isUnderPrefix(key: string, prefix: string): boolean {
  return prefix === "" || key.startsWith(`${prefix.replace(/\/+$/, "")}/`);
}

export async function walkFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (findSystemErrno(error) === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(absolutePath, out);
    else if (entry.isFile()) out.push(absolutePath);
  }
}
