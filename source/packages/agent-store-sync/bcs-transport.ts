import { Code, ConnectError, createClient, type CallOptions, type Client, type Transport } from "@connectrpc/connect";
import {
  AbortAgentStoreMultipartWritesRequest,
  AgentStoreDeleteFileStatus,
  AgentStoreDirectoryListingMode,
  AgentStoreMultipartOperationFailureCode,
  AgentStoreSourceKind as AgentStoreSourceKindProto,
  AgentStoreSourceRef,
  AgentStoreWriteFileEntry,
  CompleteAgentStoreMultipartWritesRequest,
  AgentStoreDeleteFileEntry,
  DeleteAgentStoreFilesRequest,
  ListAgentStoreDirectoryRequest,
  MintAgentStoreTokenRequest,
  PresignAgentStoreReadsRequest,
  PresignAgentStoreWritesRequest,
  AgentStoreMultipartUploadPartDescriptor,
  AgentStoreMultipartUploadContext,
  AgentStoreMultipartWriteCompletion as AgentStoreMultipartWriteCompletionProto,
  AgentStoreMultipartUploadedPart,
  AgentStoreMultipartWriteAbort as AgentStoreMultipartWriteAbortProto,
} from "../proto/generated/aiserver/v1/background_composer_pb.js";
import { BackgroundComposerService } from "../proto/generated/aiserver/v1/background_composer_connect.js";
import { normalizeS3Etag } from "./etag.js";
import { AgentStoreDirectoryListingError, AgentStoreProtocolError, AgentStoreUnauthorizedError } from "./bcs-client.js";
import { adaptFlatAgentStoreList } from "./bcs-list-adapter.js";
import { normalizeRelPath } from "./safe-paths.js";

const AGENT_STORE_TOKEN_HEADER = "x-agent-store-token";

const DIRECTORY_LIST_CACHE_TTL_MS = 1_000;
const DIRECTORY_LIST_PAGE_SIZE = 1_000;
const DIRECTORY_LIST_MAX_PAGES = 10;
const DIRECTORY_LIST_MAX_ENTRIES = DIRECTORY_LIST_PAGE_SIZE * DIRECTORY_LIST_MAX_PAGES;
const DEFAULT_RPC_TIMEOUT_MS = 60_000;

export type AgentStoreSourceKind = "cloud" | "local" | "user" | "team" | "automation";
export type AgentStoreMintTarget =
  | { readonly kind: "share"; readonly shareId: string }
  | { readonly kind: "store"; readonly storeId: string }
  | { readonly kind: "source"; readonly sourceKind: AgentStoreSourceKind; readonly sourceId: string };

export interface AgentStoreToken {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly storeIds: readonly string[];
}

export interface AgentStoreReadInstruction {
  readonly relPath: string;
  readonly url: string;
  readonly expiresAtMs: number;
}

export interface AgentStoreWriteFile {
  readonly relPath: string;
  readonly sha: string;
  readonly size: number;
  readonly baseEtag?: string;
  readonly expectAbsent?: boolean;
  readonly multipartParts?: readonly {
    readonly partNumber: number;
    readonly offsetBytes: number;
    readonly sizeBytes: number;
    readonly checksumSha256: Uint8Array;
  }[];
}

export interface AgentStoreMultipartContext {
  readonly uploadId: string;
  readonly storeId: string;
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly sha: string;
  readonly expectedPartCount: number;
  readonly precondition: { readonly case: "baseEtag"; readonly value: string } | { readonly case: "expectAbsent"; readonly value: boolean } | { readonly case: undefined };
  readonly sessionId: string;
}

export interface AgentStoreMultipartWriteInstruction {
  readonly context: AgentStoreMultipartContext;
  readonly parts: readonly { readonly partNumber: number; readonly url: string; readonly headers: Record<string, string>; readonly offsetBytes: number; readonly sizeBytes: number }[];
  readonly partUrlsExpiresAtMs: number;
}

export interface AgentStoreWriteInstruction {
  readonly relPath: string;
  readonly sha: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly expiresAtMs: number;
  readonly multipart?: AgentStoreMultipartWriteInstruction;
  readonly primaryPreconditionFailed?: boolean;
  readonly lockRedirect?: { readonly conflictRelPath: string; readonly lockExpiresAtMs: number };
  readonly conflict?: { readonly relPath: string; readonly url: string; readonly headers: Record<string, string>; readonly expiresAtMs: number; readonly multipart?: AgentStoreMultipartWriteInstruction };
}

export interface AgentStoreMultipartWriteCompletion {
  readonly context: AgentStoreMultipartContext;
  readonly parts: readonly { readonly partNumber: number; readonly etag: string; readonly checksumSha256: Uint8Array }[];
}

export interface AgentStoreMultipartWriteAbort {
  readonly context: AgentStoreMultipartContext;
}

export interface AgentStoreListFile {
  readonly relPath: string;
  readonly etag: string;
  readonly size: number;
  readonly serverMtimeMs: number;
}

export interface AgentStoreTombstone {
  readonly relPath: string;
  readonly tombstoneEtag: string;
  readonly deletedAtMs: number;
}

export interface AgentStoreListing {
  readonly files: readonly AgentStoreListFile[];
  readonly subdirs: readonly string[];
  readonly tombstones: readonly AgentStoreTombstone[];
  readonly listingComplete: boolean;
  readonly skippedUnsafeEntries?: number;
}

export interface BcsAgentStoreClient {
  mintAgentStoreToken(request: unknown, options?: CallOptions): Promise<any>;
  listAgentStoreDirectory(request: unknown, options?: CallOptions): Promise<any>;
  presignAgentStoreReads(request: unknown, options?: CallOptions): Promise<any>;
  presignAgentStoreWrites(request: unknown, options?: CallOptions): Promise<any>;
  completeAgentStoreMultipartWrites(request: unknown, options?: CallOptions): Promise<any>;
  abortAgentStoreMultipartWrites(request: unknown, options?: CallOptions): Promise<any>;
  deleteAgentStoreFiles(request: unknown, options?: CallOptions): Promise<any>;
}

export interface BcsAgentStoreTransportInput {
  readonly client?: BcsAgentStoreClient | Client<typeof BackgroundComposerService>;
  readonly transport?: Transport;
  readonly now?: () => number;
  readonly flatFileListCacheTtlMs?: number;
  readonly mintTokenHeaders?: Record<string, string>;
  readonly rpcTimeoutMs?: number;
}

interface CachedDirectoryListing { readonly promise: Promise<AgentStoreListing>; readonly expiresAtMs: number }
interface CachedFlatListing { readonly files: readonly AgentStoreListFile[]; readonly tombstones: readonly AgentStoreTombstone[]; readonly expiresAtMs: number }

export class BcsAgentStoreTransport {
  private readonly client: BcsAgentStoreClient;
  private readonly now: () => number;
  private readonly directoryListCacheTtlMs: number;
  private readonly mintTokenHeaders: Record<string, string> | undefined;
  private readonly rpcTimeoutMs: number;
  private readonly directoryListCache = new Map<string, CachedDirectoryListing>();
  private readonly completeFlatListCache = new Map<string, CachedFlatListing>();
  private readonly listCacheGenerationByTarget = new Map<string, number>();
  private readonly knownLargeTargets = new Set<string>();

  constructor(input: BcsAgentStoreTransportInput) {
    this.now = input.now ?? Date.now;
    this.directoryListCacheTtlMs = input.flatFileListCacheTtlMs ?? DIRECTORY_LIST_CACHE_TTL_MS;
    this.mintTokenHeaders = input.mintTokenHeaders;
    this.rpcTimeoutMs = normalizeRpcTimeoutMs(input.rpcTimeoutMs);
    if (input.client !== undefined) {
      this.client = input.client as BcsAgentStoreClient;
    } else if (input.transport !== undefined) {
      this.client = createClient(BackgroundComposerService, input.transport) as unknown as BcsAgentStoreClient;
    } else {
      throw new Error("BcsAgentStoreTransport requires either `client` or `transport`.");
    }
  }

  async mintToken(target: AgentStoreMintTarget, options?: { readonly signal?: AbortSignal }): Promise<AgentStoreToken> {
    try {
      const response = await this.invokeRpc(
        callOptions => this.client.mintAgentStoreToken(mintAgentStoreTokenRequestForTarget(target), callOptions),
        { ...(this.mintTokenHeaders === undefined ? {} : { headers: { ...this.mintTokenHeaders } }), ...(options?.signal === undefined ? {} : { signal: options.signal }) },
      );
      return {
        token: response.token,
        expiresAtMs: Number(response.expiresAtMs),
        storeIds: [...(response.storeIds.length > 0 ? response.storeIds : response.agentIds)],
      };
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  async listFiles(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly relPath: string; readonly shareId?: string; readonly signal?: AbortSignal }): Promise<AgentStoreListing> {
    return this.fetchCachedDirectoryList(args);
  }

  async presignReads(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly relPaths: readonly string[]; readonly shareId?: string; readonly signal?: AbortSignal }): Promise<readonly AgentStoreReadInstruction[]> {
    try {
      const response = await this.invokeRpc(
        options => this.client.presignAgentStoreReads(new PresignAgentStoreReadsRequest(args.shareId !== undefined ? { shareId: args.shareId, relPaths: [...args.relPaths] } : { storeId: args.storeId, relPaths: [...args.relPaths] }), options),
        agentStoreCallOptions(args.token.token, args.signal),
      );
      return response.instructions.map((instruction: any) => ({ relPath: instruction.relPath, url: instruction.url, expiresAtMs: Number(instruction.expiresAtMs) }));
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  async presignWrites(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly files: readonly AgentStoreWriteFile[]; readonly signal?: AbortSignal }): Promise<readonly AgentStoreWriteInstruction[]> {
    this.invalidateListCache({ storeId: args.storeId });
    const shaByRelPath = new Map(args.files.map(file => [normalizeRelPath(file.relPath), file.sha]));
    for (const file of args.files) {
      if (file.baseEtag !== undefined && file.expectAbsent === true) throw new Error(`Agent store write for ${file.relPath} sets both baseEtag and expectAbsent; they are mutually exclusive`);
      if (file.baseEtag !== undefined && normalizeS3Etag(file.baseEtag).length === 0) throw new Error(`Agent store write for ${file.relPath} carries an empty baseEtag`);
    }
    try {
      const response = await this.invokeRpc(
        options => this.client.presignAgentStoreWrites(new PresignAgentStoreWritesRequest({
          storeId: args.storeId,
          files: args.files.map(file => new AgentStoreWriteFileEntry({
            relPath: file.relPath,
            sizeBytes: BigInt(file.size),
            sha: file.sha,
            ...(file.multipartParts === undefined ? {} : { multipartParts: file.multipartParts.map(part => new AgentStoreMultipartUploadPartDescriptor({ partNumber: part.partNumber, offsetBytes: BigInt(part.offsetBytes), sizeBytes: BigInt(part.sizeBytes), checksumSha256: new Uint8Array(part.checksumSha256) })) }),
            ...(file.baseEtag !== undefined ? { precondition: { case: "baseEtag" as const, value: normalizeS3Etag(file.baseEtag) } } : file.expectAbsent === true ? { precondition: { case: "expectAbsent" as const, value: true } } : {}),
          })),
        }), options),
        agentStoreCallOptions(args.token.token, args.signal),
      );
      return response.instructions.map((instruction: any, index: number) => {
        const relPath = instruction.relPath;
        let sha = args.files[index]?.sha;
        try { sha = shaByRelPath.get(normalizeRelPath(relPath)) ?? sha; } catch { /* response is validated below */ }
        if (sha === undefined) throw new Error(`BCS presign write response missing requested file: ${relPath}`);
        return {
          relPath,
          sha,
          url: instruction.url,
          headers: { ...instruction.headers },
          expiresAtMs: Number(instruction.expiresAtMs),
          ...(instruction.multipart === undefined ? {} : { multipart: mapMultipartWriteInstruction(instruction.multipart) }),
          ...(instruction.primaryPreconditionFailed ? { primaryPreconditionFailed: true } : {}),
          ...(instruction.lockRedirect === undefined ? {} : { lockRedirect: { conflictRelPath: instruction.lockRedirect.conflictRelPath, lockExpiresAtMs: Number(instruction.lockRedirect.lockExpiresAtMs) } }),
          ...(instruction.conflict === undefined ? {} : { conflict: mapConflictWriteInstruction(instruction.conflict) }),
        };
      });
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  async completeMultipartWrites(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly completions: readonly AgentStoreMultipartWriteCompletion[]; readonly signal?: AbortSignal }): Promise<readonly { readonly kind: "success" | "failure"; readonly relPath: string; readonly etag?: string; readonly code?: string }[]> {
    this.invalidateListCache({ storeId: args.storeId });
    try {
      const response = await this.invokeRpc(
        options => this.client.completeAgentStoreMultipartWrites(new CompleteAgentStoreMultipartWritesRequest({ storeId: args.storeId, completions: args.completions.map(multipartWriteCompletionToProto) }), options),
        agentStoreCallOptions(args.token.token, args.signal),
      );
      return correlateMultipartCompletionResults({ inputs: args.completions, results: response.results });
    } catch (error) {
      throw mapConnectError(error);
    } finally {
      this.invalidateListCache({ storeId: args.storeId });
    }
  }

  async abortMultipartWrites(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly uploads: readonly AgentStoreMultipartWriteAbort[]; readonly signal?: AbortSignal }): Promise<readonly { readonly kind: "success" | "failure"; readonly relPath: string; readonly alreadyFinished?: boolean; readonly code?: string }[]> {
    try {
      const response = await this.invokeRpc(
        options => this.client.abortAgentStoreMultipartWrites(new AbortAgentStoreMultipartWritesRequest({ storeId: args.storeId, uploads: args.uploads.map(multipartWriteAbortToProto) }), options),
        agentStoreCallOptions(args.token.token, args.signal),
      );
      return correlateMultipartAbortResults({ inputs: args.uploads, results: response.results });
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  async deleteFiles(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly files: readonly { readonly relPath: string; readonly baseEtag: string; readonly mutationId?: string }[]; readonly signal?: AbortSignal }): Promise<readonly { readonly relPath: string; readonly status: string; readonly tombstoneEtag?: string; readonly currentEtag?: string }[]> {
    for (const file of args.files) if (normalizeS3Etag(file.baseEtag).length === 0) throw new Error(`Agent store delete for ${file.relPath} carries an empty baseEtag`);
    this.invalidateListCache({ storeId: args.storeId });
    try {
      const response = await this.invokeRpc(
        options => this.client.deleteAgentStoreFiles(new DeleteAgentStoreFilesRequest({ storeId: args.storeId, files: args.files.map(file => new AgentStoreDeleteFileEntry({ relPath: file.relPath, baseEtag: normalizeS3Etag(file.baseEtag), ...(file.mutationId === undefined ? {} : { mutationId: file.mutationId }) })) }), options),
        agentStoreCallOptions(args.token.token, args.signal),
      );
      const outcomes = response.results.map((result: any) => {
        const relPath = normalizeHarnessRelPath(result.relPath);
        const tombstoneEtag = normalizeS3Etag(result.tombstoneEtag);
        switch (result.status) {
          case AgentStoreDeleteFileStatus.DELETED: return { relPath, status: "deleted", tombstoneEtag };
          case AgentStoreDeleteFileStatus.ALREADY_DELETED: return { relPath, status: "already_deleted", ...(tombstoneEtag.length === 0 ? {} : { tombstoneEtag }) };
          case AgentStoreDeleteFileStatus.CONFLICT: { const currentEtag = normalizeS3Etag(result.currentEtag); return { relPath, status: "conflict", ...(currentEtag.length === 0 ? {} : { currentEtag }) }; }
          case AgentStoreDeleteFileStatus.UNSPECIFIED: throw new Error(`BCS delete returned UNSPECIFIED status for ${relPath}`);
          default: throw new Error(`BCS delete returned an unknown status for ${relPath}: ${result.status}`);
        }
      });
      this.invalidateListCache({ storeId: args.storeId });
      return outcomes;
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  invalidateListCache({ storeId, shareId }: { readonly storeId: string; readonly shareId?: string }): void {
    const targets = new Set([`self:${storeId}`]);
    if (shareId !== undefined) targets.add(`share:${shareId}`);
    for (const target of targets) this.listCacheGenerationByTarget.set(target, (this.listCacheGenerationByTarget.get(target) ?? 0) + 1);
    for (const key of this.directoryListCache.keys()) if (targets.has(key.split("\0", 1)[0] ?? "")) this.directoryListCache.delete(key);
    for (const key of this.completeFlatListCache.keys()) if (targets.has(key.split("\0", 1)[0] ?? "")) this.completeFlatListCache.delete(key);
  }

  private fetchCachedDirectoryList(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly relPath: string; readonly shareId?: string; readonly signal?: AbortSignal }): Promise<AgentStoreListing> {
    if (args.signal?.aborted === true) return Promise.reject(args.signal.reason instanceof Error ? args.signal.reason : new DOMException("The operation was aborted", "AbortError"));
    const now = this.now();
    for (const [key, candidate] of this.completeFlatListCache) if (candidate.expiresAtMs <= now) this.completeFlatListCache.delete(key);
    const flat = this.completeFlatListCache.get(completeFlatListCacheKey(args));
    if (flat !== undefined) return Promise.resolve(adaptFlatAgentStoreList({ files: flat.files, relPath: args.relPath, tombstones: flat.tombstones, listingComplete: true }));
    const cacheKey = directoryListCacheKey(args);
    let entry = this.directoryListCache.get(cacheKey);
    if (entry === undefined || entry.expiresAtMs <= now) {
      for (const [key, candidate] of this.directoryListCache) if (candidate.expiresAtMs <= now) this.directoryListCache.delete(key);
      const promise = this.fetchDirectoryList(args).then(listing => {
        if (isUncacheableAllUnsafeListing(listing) && this.directoryListCache.get(cacheKey)?.promise === promise) this.directoryListCache.delete(cacheKey);
        return listing;
      }).catch(error => { if (this.directoryListCache.get(cacheKey)?.promise === promise) this.directoryListCache.delete(cacheKey); throw error; });
      entry = { promise, expiresAtMs: now + this.directoryListCacheTtlMs };
      this.directoryListCache.set(cacheKey, entry);
    }
    return entry.promise;
  }

  private async fetchDirectoryList(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly relPath: string; readonly shareId?: string; readonly signal?: AbortSignal }): Promise<AgentStoreListing> {
    try {
      const files = new Map<string, AgentStoreListFile>();
      const subdirs = new Set<string>();
      const tombstones = new Map<string, AgentStoreTombstone>();
      const seenPageTokens = new Set<string>();
      const targetKey = listingTargetKey(args);
      const cacheGeneration = this.listCacheGenerationByTarget.get(targetKey) ?? 0;
      const preferCompleteFlatStore = args.relPath === "" && !this.knownLargeTargets.has(targetKey);
      let pageToken = "";
      let pageCount = 0;
      do {
        pageCount += 1;
        if (pageCount > DIRECTORY_LIST_MAX_PAGES) throw new AgentStoreDirectoryListingError(`Agent store directory listing exceeded ${DIRECTORY_LIST_MAX_PAGES} pages`);
        const response = await this.invokeRpc(
          options => this.client.listAgentStoreDirectory(new ListAgentStoreDirectoryRequest({ ...(args.shareId === undefined ? { storeId: args.storeId } : { shareId: args.shareId }), relativePath: args.relPath, pageSize: DIRECTORY_LIST_PAGE_SIZE, pageToken, preferCompleteFlatStore: preferCompleteFlatStore && pageToken === "" }), options),
          agentStoreCallOptions(args.token.token, args.signal),
        );
        if (response.mode === AgentStoreDirectoryListingMode.COMPLETE_FLAT_STORE) {
          const flatFiles = response.files.map((file: any) => ({ relPath: file.relPath, etag: normalizeS3Etag(file.etag), size: Number(file.sizeBytes), serverMtimeMs: Number(file.lastModifiedMs) }));
          const flatTombstones = adaptTombstoneEntries(response.tombstones);
          if (flatFiles.length + flatTombstones.length > DIRECTORY_LIST_MAX_ENTRIES) throw new AgentStoreDirectoryListingError(`Agent store directory listing exceeded ${DIRECTORY_LIST_MAX_ENTRIES} entries`);
          const completeListing = adaptFlatAgentStoreList({ files: flatFiles, relPath: "", tombstones: flatTombstones, listingComplete: true });
          if ((this.listCacheGenerationByTarget.get(targetKey) ?? 0) === cacheGeneration && !isUncacheableAllUnsafeListing(completeListing)) this.completeFlatListCache.set(completeFlatListCacheKey(args), { files: completeListing.files, tombstones: flatTombstones, expiresAtMs: this.now() + this.directoryListCacheTtlMs });
          return completeListing;
        }
        if (preferCompleteFlatStore && pageToken === "") this.knownLargeTargets.add(targetKey);
        for (const file of response.files) files.set(file.relPath, { relPath: file.relPath, etag: normalizeS3Etag(file.etag), size: Number(file.sizeBytes), serverMtimeMs: Number(file.lastModifiedMs) });
        for (const subdir of response.subdirs) subdirs.add(subdir);
        for (const tombstone of adaptTombstoneEntries(response.tombstones)) tombstones.set(tombstone.relPath, tombstone);
        if (files.size + subdirs.size + tombstones.size > DIRECTORY_LIST_MAX_ENTRIES) throw new AgentStoreDirectoryListingError(`Agent store directory listing exceeded ${DIRECTORY_LIST_MAX_ENTRIES} entries`);
        pageToken = response.nextPageToken;
        if (pageToken !== "" && seenPageTokens.has(pageToken)) throw new AgentStoreDirectoryListingError("Agent store directory listing repeated a page token");
        if (pageToken !== "") seenPageTokens.add(pageToken);
      } while (pageToken !== "");
      return { files: [...files.values()].sort((a, b) => a.relPath.localeCompare(b.relPath)), subdirs: [...subdirs].sort(), tombstones: [...tombstones.values()].sort((a, b) => a.relPath.localeCompare(b.relPath)), listingComplete: true };
    } catch (error) {
      throw mapConnectError(error);
    }
  }

  private buildCallOptions(base: CallOptions | undefined): { readonly options: CallOptions | undefined; readonly timeoutSignal: AbortSignal | undefined } {
    if (this.rpcTimeoutMs <= 0) return { options: base, timeoutSignal: undefined };
    const timeoutSignal = AbortSignal.timeout(this.rpcTimeoutMs);
    const signal = base?.signal === undefined ? timeoutSignal : AbortSignal.any([base.signal, timeoutSignal]);
    return { options: { ...base, timeoutMs: this.rpcTimeoutMs, signal }, timeoutSignal };
  }

  private async invokeRpc(invoke: (options: CallOptions | undefined) => Promise<any>, base?: CallOptions): Promise<any> {
    const { options, timeoutSignal } = this.buildCallOptions(base);
    return rejectWhenAborted(invoke(options), { signal: options?.signal, timeoutSignal });
  }
}

function normalizeRpcTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_RPC_TIMEOUT_MS;
  return Math.floor(value);
}

function rejectWhenAborted<T>(promise: Promise<T>, args: { readonly signal: AbortSignal | undefined; readonly timeoutSignal: AbortSignal | undefined }): Promise<T> {
  if (args.signal === undefined) return promise;
  if (args.signal.aborted) return Promise.reject(rpcAbortError(args));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(rpcAbortError(args)); };
    const cleanup = () => args.signal?.removeEventListener("abort", onAbort);
    args.signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => {
      cleanup();
      if (args.timeoutSignal?.aborted === true && isAbortShapedRpcError(error)) reject(rpcDeadlineExceededError(args.timeoutSignal));
      else reject(error);
    });
  });
}

function rpcAbortError(args: { readonly signal: AbortSignal | undefined; readonly timeoutSignal: AbortSignal | undefined }): ConnectError {
  if (args.timeoutSignal?.aborted === true) return rpcDeadlineExceededError(args.timeoutSignal);
  if (args.signal === undefined) return new ConnectError("agent store RPC canceled", Code.Canceled);
  const reason = args.signal.reason;
  if (reason instanceof ConnectError) return reason;
  if (reason instanceof Error && reason.name === "AbortError") return new ConnectError(reason.message, Code.Canceled);
  return new ConnectError(reason instanceof Error && reason.message.length > 0 ? reason.message : "agent store RPC canceled", Code.Canceled);
}

function rpcDeadlineExceededError(signal: AbortSignal): ConnectError {
  const reason = signal.reason;
  if (reason instanceof ConnectError) return reason;
  return new ConnectError(reason instanceof Error && reason.message.length > 0 ? reason.message : "agent store RPC deadline exceeded", Code.DeadlineExceeded);
}

function isAbortShapedRpcError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError" || error instanceof ConnectError && (error.code === Code.Canceled || error.code === Code.DeadlineExceeded);
}

function adaptTombstoneEntries(tombstones: readonly any[] | undefined): AgentStoreTombstone[] {
  return (tombstones ?? []).map(tombstone => ({ relPath: normalizeHarnessRelPath(tombstone.relPath), tombstoneEtag: normalizeS3Etag(tombstone.tombstoneEtag), deletedAtMs: Number(tombstone.deletedAtMs) }));
}

function mintAgentStoreTokenRequestForTarget(target: AgentStoreMintTarget): MintAgentStoreTokenRequest {
  switch (target.kind) {
    case "share": return new MintAgentStoreTokenRequest({ shareId: target.shareId });
    case "store": return new MintAgentStoreTokenRequest({ storeId: target.storeId });
    case "source": return new MintAgentStoreTokenRequest({ source: new AgentStoreSourceRef({ kind: agentStoreSourceKindToProto(target.sourceKind), sourceId: target.sourceId }) });
  }
}

function agentStoreSourceKindToProto(kind: AgentStoreSourceKind): AgentStoreSourceKindProto {
  switch (kind) {
    case "cloud": return AgentStoreSourceKindProto.CLOUD;
    case "local": return AgentStoreSourceKindProto.LOCAL;
    case "user": return AgentStoreSourceKindProto.USER;
    case "team": return AgentStoreSourceKindProto.TEAM;
    case "automation": return AgentStoreSourceKindProto.AUTOMATION;
  }
}

function agentStoreCallOptions(token: string, signal: AbortSignal | undefined): CallOptions {
  return { headers: { [AGENT_STORE_TOKEN_HEADER]: token }, ...(signal === undefined ? {} : { signal }) };
}

function mapConflictWriteInstruction(instruction: any): AgentStoreWriteInstruction["conflict"] {
  return { relPath: instruction.relPath, url: instruction.url, headers: { ...instruction.headers }, expiresAtMs: Number(instruction.expiresAtMs), ...(instruction.multipart === undefined ? {} : { multipart: mapMultipartWriteInstruction(instruction.multipart) }) };
}

function mapMultipartWriteInstruction(instruction: any): AgentStoreMultipartWriteInstruction {
  if (instruction.context === undefined) throw new AgentStoreProtocolError("BCS multipart write instruction is missing context");
  return { context: multipartContextFromProto(instruction.context), parts: instruction.parts.map((part: any) => ({ partNumber: part.partNumber, url: part.url, headers: { ...part.headers }, offsetBytes: Number(part.offsetBytes), sizeBytes: Number(part.sizeBytes) })), partUrlsExpiresAtMs: Number(instruction.partUrlsExpiresAtMs) };
}

function multipartContextFromProto(context: any): AgentStoreMultipartContext {
  return { uploadId: context.uploadId, storeId: context.storeId, relPath: context.relPath, sizeBytes: Number(context.sizeBytes), sha: context.sha, expectedPartCount: context.expectedPartCount, precondition: cloneMultipartPrecondition(context.precondition), sessionId: context.sessionId };
}

function cloneMultipartPrecondition(precondition: any): AgentStoreMultipartContext["precondition"] {
  switch (precondition.case) {
    case "baseEtag": return { case: "baseEtag", value: precondition.value };
    case "expectAbsent": return { case: "expectAbsent", value: precondition.value };
    default: return { case: undefined };
  }
}

function multipartContextToProto(context: AgentStoreMultipartContext): AgentStoreMultipartUploadContext {
  return new AgentStoreMultipartUploadContext({ uploadId: context.uploadId, storeId: context.storeId, relPath: context.relPath, sizeBytes: BigInt(context.sizeBytes), sha: context.sha, expectedPartCount: context.expectedPartCount, precondition: cloneMultipartPrecondition(context.precondition), sessionId: context.sessionId });
}

function multipartWriteCompletionToProto(completion: AgentStoreMultipartWriteCompletion): AgentStoreMultipartWriteCompletionProto {
  return new AgentStoreMultipartWriteCompletionProto({ context: multipartContextToProto(completion.context), parts: completion.parts.map(part => new AgentStoreMultipartUploadedPart({ partNumber: part.partNumber, etag: part.etag, checksumSha256: new Uint8Array(part.checksumSha256) })) });
}

function multipartWriteAbortToProto(upload: AgentStoreMultipartWriteAbort): AgentStoreMultipartWriteAbortProto {
  return new AgentStoreMultipartWriteAbortProto({ context: multipartContextToProto(upload.context) });
}

function correlateMultipartCompletionResults(args: { readonly inputs: readonly AgentStoreMultipartWriteCompletion[]; readonly results: readonly any[] }): readonly { readonly kind: "success" | "failure"; readonly relPath: string; readonly etag?: string; readonly code?: string }[] {
  const ordered: ({ readonly kind: "success" | "failure"; readonly relPath: string; readonly etag?: string; readonly code?: string } | undefined)[] = Array.from({ length: args.inputs.length });
  for (const result of args.results) {
    const inputIndex = validateMultipartResultIndex({ inputCount: args.inputs.length, inputIndex: result.inputIndex, kind: "complete" });
    if (ordered[inputIndex] !== undefined) throw new AgentStoreProtocolError(`BCS multipart complete response repeated inputIndex ${inputIndex}`);
    const relPath = normalizeMultipartResponseRelPath({ relPath: result.relPath, inputIndex, kind: "complete" });
    if (relPath !== normalizeRelPath(args.inputs[inputIndex]?.context.relPath ?? "")) throw new AgentStoreProtocolError("BCS multipart complete response relPath mismatch at inputIndex " + inputIndex);
    ordered[inputIndex] = mapMultipartCompletionResult({ result, relPath });
  }
  return requireCompleteMultipartResultSet({ ordered, kind: "complete" });
}

function correlateMultipartAbortResults(args: { readonly inputs: readonly AgentStoreMultipartWriteAbort[]; readonly results: readonly any[] }): readonly { readonly kind: "success" | "failure"; readonly relPath: string; readonly alreadyFinished?: boolean; readonly code?: string }[] {
  const ordered: ({ readonly kind: "success" | "failure"; readonly relPath: string; readonly alreadyFinished?: boolean; readonly code?: string } | undefined)[] = Array.from({ length: args.inputs.length });
  for (const result of args.results) {
    const inputIndex = validateMultipartResultIndex({ inputCount: args.inputs.length, inputIndex: result.inputIndex, kind: "abort" });
    if (ordered[inputIndex] !== undefined) throw new AgentStoreProtocolError(`BCS multipart abort response repeated inputIndex ${inputIndex}`);
    const relPath = normalizeMultipartResponseRelPath({ relPath: result.relPath, inputIndex, kind: "abort" });
    if (relPath !== normalizeRelPath(args.inputs[inputIndex]?.context.relPath ?? "")) throw new AgentStoreProtocolError("BCS multipart abort response relPath mismatch at inputIndex " + inputIndex);
    ordered[inputIndex] = mapMultipartAbortResult({ result, relPath });
  }
  return requireCompleteMultipartResultSet({ ordered, kind: "abort" });
}

function validateMultipartResultIndex(args: { readonly inputCount: number; readonly inputIndex: number; readonly kind: string }): number {
  if (!Number.isInteger(args.inputIndex) || args.inputIndex < 0 || args.inputIndex >= args.inputCount) throw new AgentStoreProtocolError(`BCS multipart ${args.kind} response returned out-of-range inputIndex ${args.inputIndex}`);
  return args.inputIndex;
}

function normalizeMultipartResponseRelPath(args: { readonly relPath: string; readonly inputIndex: number; readonly kind: string }): string {
  try { return normalizeRelPath(args.relPath); } catch { throw new AgentStoreProtocolError(`BCS multipart ${args.kind} response returned an invalid relPath at inputIndex ${args.inputIndex}`); }
}

function requireCompleteMultipartResultSet<T extends { readonly kind: string }>(args: { readonly ordered: readonly (T | undefined)[]; readonly kind: string }): readonly T[] {
  const output: T[] = [];
  for (const [index, result] of args.ordered.entries()) {
    if (result === undefined) throw new AgentStoreProtocolError(`BCS multipart ${args.kind} response missing result for inputIndex ${index}`);
    output.push(result);
  }
  return output;
}

function mapMultipartCompletionResult(args: { readonly result: any; readonly relPath: string }): { readonly kind: "success" | "failure"; readonly relPath: string; readonly etag?: string; readonly code?: string } | undefined {
  switch (args.result.outcome.case) {
    case "success": return { kind: "success", relPath: args.relPath, etag: normalizeS3Etag(args.result.outcome.value.etag) };
    case "failure": return { kind: "failure", relPath: args.relPath, code: mapMultipartFailureCode(args.result.outcome.value.code) };
    case undefined: return { kind: "failure", relPath: args.relPath, code: "internal" };
  }
}

function mapMultipartAbortResult(args: { readonly result: any; readonly relPath: string }): { readonly kind: "success" | "failure"; readonly relPath: string; readonly alreadyFinished?: boolean; readonly code?: string } | undefined {
  switch (args.result.outcome.case) {
    case "success": return { kind: "success", relPath: args.relPath, alreadyFinished: args.result.outcome.value.alreadyFinished };
    case "failure": return { kind: "failure", relPath: args.relPath, code: mapMultipartFailureCode(args.result.outcome.value.code) };
    case undefined: return { kind: "failure", relPath: args.relPath, code: "internal" };
  }
}

function mapMultipartFailureCode(code: number): string {
  switch (code) {
    case AgentStoreMultipartOperationFailureCode.UNSPECIFIED: return "internal";
    case AgentStoreMultipartOperationFailureCode.PRECONDITION_FAILED: return "precondition_failed";
    case AgentStoreMultipartOperationFailureCode.UPLOAD_NOT_FOUND: return "upload_not_found";
    case AgentStoreMultipartOperationFailureCode.INVALID_PARTS: return "invalid_parts";
    case AgentStoreMultipartOperationFailureCode.CHECKSUM_MISMATCH: return "checksum_mismatch";
    case AgentStoreMultipartOperationFailureCode.TRANSIENT: return "transient";
    case AgentStoreMultipartOperationFailureCode.INTERNAL: return "internal";
    case AgentStoreMultipartOperationFailureCode.RESTART_REQUIRED: return "restart_required";
    default: return "unknown";
  }
}

function directoryListCacheKey(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly relPath: string; readonly shareId?: string }): string {
  return `${listingTargetKey(args)}\0${args.token.token}\0${normalizeHarnessRelPath(args.relPath)}`;
}
function completeFlatListCacheKey(args: { readonly token: AgentStoreToken; readonly storeId: string; readonly shareId?: string }): string { return `${listingTargetKey(args)}\0${args.token.token}`; }
function listingTargetKey(args: { readonly storeId: string; readonly shareId?: string }): string { return args.shareId !== undefined ? `share:${args.shareId}` : `self:${args.storeId}`; }
function normalizeHarnessRelPath(relPath: string): string { return relPath.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, ""); }
function isUncacheableAllUnsafeListing(listing: AgentStoreListing): boolean { return (listing.skippedUnsafeEntries ?? 0) > 0 && listing.files.length === 0; }
function mapConnectError(error: unknown): unknown {
  if (error instanceof ConnectError && (error.code === Code.Unauthenticated || error.code === Code.PermissionDenied)) return new AgentStoreUnauthorizedError(error.message);
  return error;
}
