import { isAgentStoreId, isCloudAgentStoreId, isValidBareUuid, parseTeamAgentStoreSourceId, parseUserAgentStoreSourceId } from "../constants/agent-store-ids.js";
import { AgentStoreUnauthorizedError } from "./bcs-client.js";
import { BackoffScheduler } from "./backoff-scheduler.js";
import { isAgentStoreMintNegativeCacheable, isAgentStoreSyncDisabledError } from "./connect-errors.js";
import type {
  AgentStoreMintTarget,
  AgentStoreMultipartWriteAbort,
  AgentStoreMultipartWriteCompletion,
  AgentStoreSourceKind,
  AgentStoreToken,
  AgentStoreWriteFile,
} from "./bcs-transport.js";

const DEFAULT_REFRESH_BUFFER_MS = 60_000;
const DEFAULT_MINT_NEGATIVE_CACHE_BASE_MS = 30_000;
const DEFAULT_MINT_NEGATIVE_CACHE_MAX_MS = 15 * 60_000;
const SYNC_DISABLED_UNTIL_MS = Number.POSITIVE_INFINITY;

interface TokenMetrics {
  tokenMinted(event: { readonly agentId: string; readonly reason: "cold" | "near_expiry" | "after_unauthorized" }): void;
  tokenRefreshUnauthorized(event: { readonly agentId: string; readonly op: string }): void;
  tokenMintNegativeCached?(event: { readonly agentId: string; readonly untilMs: number }): void;
  tokenMintFailureCached?(event: { readonly agentId: string; readonly kind: "stand_down" | "backoff" }): void;
}

const NOOP_METRICS: TokenMetrics = { tokenMinted() {}, tokenRefreshUnauthorized() {} };

export interface TokenCachingAgentStoreTransport {
  mintToken(target: AgentStoreMintTarget): Promise<AgentStoreToken>;
  listFiles(args: Record<string, unknown>): Promise<unknown>;
  presignReads(args: Record<string, unknown>): Promise<unknown>;
  presignWrites(args: Record<string, unknown>): Promise<unknown>;
  deleteFiles?(args: Record<string, unknown>): Promise<unknown>;
  completeMultipartWrites?(args: Record<string, unknown>): Promise<unknown>;
  abortMultipartWrites?(args: Record<string, unknown>): Promise<unknown>;
  invalidateListCache?(args: { readonly storeId: string; readonly shareId?: string }): void;
}

export interface TokenCachingAgentStoreClientOptions {
  readonly metrics?: TokenMetrics;
  readonly now?: () => number;
  readonly refreshBufferMs?: number;
  readonly mintNegativeCacheBaseMs?: number;
  readonly mintNegativeCacheMaxMs?: number;
  readonly onSyncDisabledMint?: (event: { readonly agentId: string; readonly message: string }) => void | Promise<void>;
}

interface OperationRequest {
  readonly agentId: string;
  readonly shareId?: string;
  readonly mintSourceKind?: AgentStoreSourceKind;
  readonly signal?: AbortSignal;
}

interface NegativeMintEntry {
  readonly error: unknown;
  readonly untilMs: number;
  readonly backoff: BackoffScheduler;
}

export class TokenCachingAgentStoreClient {
  private readonly transport: TokenCachingAgentStoreTransport;
  private readonly tokens = new Map<string, AgentStoreToken>();
  private readonly inFlightMints = new Map<string, Promise<AgentStoreToken>>();
  private readonly mintNegativeCache = new Map<string, NegativeMintEntry>();
  private readonly metrics: TokenMetrics;
  private readonly now: () => number;
  private readonly refreshBufferMs: number;
  private readonly mintNegativeCacheBaseMs: number;
  private readonly mintNegativeCacheMaxMs: number;
  private readonly onSyncDisabledMint: TokenCachingAgentStoreClientOptions["onSyncDisabledMint"];

  declare readonly completeMultipartWrites?: (request: OperationRequest & { readonly completions: readonly AgentStoreMultipartWriteCompletion[] }) => Promise<unknown>;
  declare readonly abortMultipartWrites?: (request: OperationRequest & { readonly uploads: readonly AgentStoreMultipartWriteAbort[] }) => Promise<unknown>;

  constructor(transport: TokenCachingAgentStoreTransport, options: TokenCachingAgentStoreClientOptions = {}) {
    this.transport = transport;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.now = options.now ?? Date.now;
    this.refreshBufferMs = options.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS;
    this.mintNegativeCacheBaseMs = options.mintNegativeCacheBaseMs ?? DEFAULT_MINT_NEGATIVE_CACHE_BASE_MS;
    this.mintNegativeCacheMaxMs = options.mintNegativeCacheMaxMs ?? DEFAULT_MINT_NEGATIVE_CACHE_MAX_MS;
    this.onSyncDisabledMint = options.onSyncDisabledMint;

    const completeMultipartWrites = transport.completeMultipartWrites;
    if (completeMultipartWrites !== undefined) {
      this.completeMultipartWrites = (request) => this.callWithRefresh({
        cacheKey: request.agentId,
        mintAgentId: request.agentId,
        opName: "completeMultipartWrites",
        ...(request.mintSourceKind === undefined ? {} : { mintSourceKind: request.mintSourceKind }),
        op: (token, storeId) => completeMultipartWrites.call(transport, { completions: request.completions, storeId, token, signal: request.signal }),
      });
    }
    const abortMultipartWrites = transport.abortMultipartWrites;
    if (abortMultipartWrites !== undefined) {
      this.abortMultipartWrites = (request) => this.callWithRefresh({
        cacheKey: request.agentId,
        mintAgentId: request.agentId,
        opName: "abortMultipartWrites",
        ...(request.mintSourceKind === undefined ? {} : { mintSourceKind: request.mintSourceKind }),
        op: (token, storeId) => abortMultipartWrites.call(transport, { uploads: request.uploads, storeId, token, signal: request.signal }),
      });
    }
  }

  async listFiles(request: OperationRequest & { readonly relPath: string }): Promise<unknown> {
    return await this.callWithRefresh({
      cacheKey: tokenCacheKey(request),
      mintAgentId: request.agentId,
      opName: "listFiles",
      ...optionalOperationFields(request),
      op: (token, storeId) => this.transport.listFiles({ relPath: request.relPath, shareId: request.shareId, storeId, token, signal: request.signal }),
    });
  }

  async presignReads(request: OperationRequest & { readonly relPaths: readonly string[] }): Promise<unknown> {
    return await this.callWithRefresh({
      cacheKey: tokenCacheKey(request),
      mintAgentId: request.agentId,
      opName: "presignReads",
      ...optionalOperationFields(request),
      op: (token, storeId) => this.transport.presignReads({ relPaths: request.relPaths, shareId: request.shareId, storeId, token, signal: request.signal }),
    });
  }

  async presignWrites(request: OperationRequest & { readonly files: readonly AgentStoreWriteFile[] }): Promise<unknown> {
    return await this.callWithRefresh({
      cacheKey: request.agentId,
      mintAgentId: request.agentId,
      opName: "presignWrites",
      ...optionalOperationFields(request),
      op: (token, storeId) => this.transport.presignWrites({ files: request.files, storeId, token, signal: request.signal }),
    });
  }

  async deleteFiles(request: OperationRequest & { readonly files: readonly { readonly relPath: string; readonly baseEtag: string; readonly mutationId?: string }[] }): Promise<unknown> {
    const deleteFiles = this.transport.deleteFiles?.bind(this.transport);
    if (deleteFiles === undefined) throw new Error("TokenCachingAgentStoreClient: transport does not support deleteFiles");
    return await this.callWithRefresh({
      cacheKey: request.agentId,
      mintAgentId: request.agentId,
      opName: "deleteFiles",
      ...optionalOperationFields(request),
      op: (token, storeId) => deleteFiles({ files: request.files, storeId, token, signal: request.signal }),
    });
  }

  invalidateListCache(request: OperationRequest): void {
    const token = this.tokens.get(tokenCacheKey(request));
    if (token === undefined) return;
    const storeId = token.storeIds[0];
    if (storeId === undefined || storeId === "") return;
    this.transport.invalidateListCache?.({ storeId, ...(request.shareId === undefined ? {} : { shareId: request.shareId }) });
  }

  private async callWithRefresh(args: {
    readonly cacheKey: string;
    readonly mintAgentId: string;
    readonly shareId?: string;
    readonly mintSourceKind?: AgentStoreSourceKind;
    readonly opName: string;
    readonly signal?: AbortSignal;
    readonly op: (token: AgentStoreToken, storeId: string) => Promise<unknown>;
  }): Promise<unknown> {
    const token = await this.getValidToken({ cacheKey: args.cacheKey, mintAgentId: args.mintAgentId, ...optionalOperationFields(args) });
    const storeId = getTokenStoreId(token);
    try {
      return await args.op(token, storeId);
    } catch (error) {
      if (!isAgentStoreUnauthorized(error)) throw error;
      this.metrics.tokenRefreshUnauthorized({ agentId: args.mintAgentId, op: args.opName });
      this.tokens.delete(args.cacheKey);
      const freshToken = await this.getValidToken({ cacheKey: args.cacheKey, mintAgentId: args.mintAgentId, mintReason: "after_unauthorized", ...optionalOperationFields(args) });
      return await args.op(freshToken, getTokenStoreId(freshToken));
    }
  }

  private async getValidToken(args: {
    readonly cacheKey: string;
    readonly mintAgentId: string;
    readonly shareId?: string;
    readonly mintSourceKind?: AgentStoreSourceKind;
    readonly mintReason?: "after_unauthorized";
    readonly signal?: AbortSignal;
  }): Promise<AgentStoreToken> {
    this.throwIfMintNegativeCached(args);
    const existing = this.tokens.get(args.cacheKey);
    if (existing !== undefined && existing.expiresAtMs - this.now() > this.refreshBufferMs) return existing;
    let pending = this.inFlightMints.get(args.cacheKey);
    if (pending === undefined) {
      this.throwIfMintNegativeCached(args);
      const reason = args.mintReason ?? (existing === undefined ? "cold" : "near_expiry");
      pending = this.transport.mintToken(agentStoreMintTarget({ agentId: args.mintAgentId, ...optionalMintTargetFields(args) })).then(token => {
        this.mintNegativeCache.delete(args.cacheKey);
        this.tokens.set(args.cacheKey, token);
        this.metrics.tokenMinted({ agentId: args.mintAgentId, reason });
        return token;
      }, error => {
        this.recordMintFailure({ cacheKey: args.cacheKey, agentId: args.mintAgentId, error });
        throw error;
      }).finally(() => { this.inFlightMints.delete(args.cacheKey); });
      this.inFlightMints.set(args.cacheKey, pending);
    }
    return await awaitWithAbortSignal(pending, args.signal);
  }

  private throwIfMintNegativeCached(args: { readonly cacheKey: string; readonly mintAgentId: string }): void {
    const cached = this.mintNegativeCache.get(args.cacheKey);
    if (cached === undefined) return;
    if (this.now() >= cached.untilMs) { this.mintNegativeCache.delete(args.cacheKey); return; }
    this.metrics.tokenMintNegativeCached?.({ agentId: args.mintAgentId, untilMs: cached.untilMs });
    throw cached.error;
  }

  private recordMintFailure(args: { readonly cacheKey: string; readonly agentId: string; readonly error: unknown }): void {
    if (isAgentStoreSyncDisabledError(args.error)) {
      const existing = this.mintNegativeCache.get(args.cacheKey);
      const backoff = existing?.backoff ?? new BackoffScheduler({ baseDelayMs: this.mintNegativeCacheBaseMs, maxDelayMs: this.mintNegativeCacheMaxMs, jitter: 0.2 });
      this.mintNegativeCache.set(args.cacheKey, { error: args.error, untilMs: SYNC_DISABLED_UNTIL_MS, backoff });
      this.metrics.tokenMintFailureCached?.({ agentId: args.agentId, kind: "stand_down" });
      this.safeNotifySyncDisabledMint({ agentId: args.agentId, message: args.error instanceof Error ? args.error.message : String(args.error) });
      return;
    }
    if (!isAgentStoreMintNegativeCacheable(args.error)) return;
    const existing = this.mintNegativeCache.get(args.cacheKey);
    const backoff = existing?.backoff ?? new BackoffScheduler({ baseDelayMs: this.mintNegativeCacheBaseMs, maxDelayMs: this.mintNegativeCacheMaxMs, jitter: 0.2 });
    this.mintNegativeCache.set(args.cacheKey, { error: args.error, untilMs: this.now() + backoff.recordFailure(), backoff });
    this.metrics.tokenMintFailureCached?.({ agentId: args.agentId, kind: "backoff" });
  }

  private safeNotifySyncDisabledMint(event: { readonly agentId: string; readonly message: string }): void {
    if (this.onSyncDisabledMint === undefined) return;
    try {
      const result = this.onSyncDisabledMint(event);
      if (result !== undefined && result !== null && typeof (result as Promise<void>).then === "function") (result as Promise<void>).then(() => undefined, () => undefined);
    } catch { /* notification is best effort */ }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function awaitWithAbortSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function getTokenStoreId(token: AgentStoreToken): string {
  const storeId = token.storeIds[0];
  if (storeId === undefined || storeId === "") throw new AgentStoreUnauthorizedError("Agent store token did not include a scoped store id");
  return storeId;
}

function tokenCacheKey(request: { readonly agentId: string; readonly shareId?: string }): string { return request.shareId ?? request.agentId; }

function optionalOperationFields(value: { readonly shareId?: string; readonly mintSourceKind?: AgentStoreSourceKind; readonly signal?: AbortSignal }): {
  readonly shareId?: string;
  readonly mintSourceKind?: AgentStoreSourceKind;
  readonly signal?: AbortSignal;
} {
  return {
    ...(value.shareId === undefined ? {} : { shareId: value.shareId }),
    ...(value.mintSourceKind === undefined ? {} : { mintSourceKind: value.mintSourceKind }),
    ...(value.signal === undefined ? {} : { signal: value.signal }),
  };
}

function optionalMintTargetFields(value: { readonly shareId?: string; readonly mintSourceKind?: AgentStoreSourceKind }): {
  readonly shareId?: string;
  readonly sourceKind?: AgentStoreSourceKind;
} {
  return {
    ...(value.shareId === undefined ? {} : { shareId: value.shareId }),
    ...(value.mintSourceKind === undefined ? {} : { sourceKind: value.mintSourceKind }),
  };
}

function agentStoreMintTarget(args: { readonly agentId: string; readonly shareId?: string; readonly sourceKind?: AgentStoreSourceKind }): AgentStoreMintTarget {
  if (args.shareId !== undefined) return { kind: "share", shareId: args.shareId };
  if (args.sourceKind !== undefined) return { kind: "source", sourceKind: args.sourceKind, sourceId: args.agentId };
  if (isAgentStoreId(args.agentId)) return { kind: "store", storeId: args.agentId };
  if (isCloudAgentStoreId(args.agentId)) return { kind: "source", sourceKind: "cloud", sourceId: args.agentId };
  if (isValidBareUuid(args.agentId)) return { kind: "source", sourceKind: "local", sourceId: args.agentId };
  if (parseUserAgentStoreSourceId(args.agentId) !== undefined) return { kind: "source", sourceKind: "user", sourceId: args.agentId };
  if (parseTeamAgentStoreSourceId(args.agentId) !== undefined) return { kind: "source", sourceKind: "team", sourceId: args.agentId };
  throw new AgentStoreUnauthorizedError("Agent store target is not a valid store or source id");
}

function isAgentStoreUnauthorized(error: unknown): boolean {
  if (error instanceof AgentStoreUnauthorizedError) return true;
  if (typeof error !== "object" || error === null) return false;
  const status = "status" in error ? (error as { readonly status?: unknown }).status : undefined;
  if (status === 401 || status === 403) return true;
  const code = "code" in error ? (error as { readonly code?: unknown }).code : undefined;
  return code === 7 || code === 16 || code === "PermissionDenied" || code === "Unauthenticated" || code === "PERMISSION_DENIED" || code === "UNAUTHENTICATED";
}
