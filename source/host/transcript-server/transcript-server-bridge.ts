import { protoInt64 } from "@bufbuild/protobuf";
import {
  CommitGrokBotTranscriptEntriesRequest,
  GrokBotTranscriptCursor,
  GrokBotTranscriptEntry,
  GrokBotTranscriptWatchFrame,
  ListGrokBotTranscriptEntriesRequest,
  WatchGrokBotTranscriptsRequest,
  type GrokBotTranscriptWatchRows,
} from "../../packages/proto/generated/aiserver/v1/grok_bot_pb.js";
import { envGateOverride } from "../../shared/node/experiments/cursor-experiments.js";
import { FLAGS } from "../../shared/node/experiments/experiment-config.ported.js";
import {
  SAND_TRANSCRIPT_DOUBLE_WRITE_GATE,
  SAND_TRANSCRIPT_SERVER_TAIL_GATE,
  SAND_TRANSCRIPT_STORE_FIRST_GATE,
  SAND_TRANSCRIPT_STORE_READ_GATE,
  isMainProcessTranscriptReadEnabled,
  type SandTranscriptGateName,
} from "../../shared/transcript-server-gates.js";

export interface TranscriptServerGates {
  readonly serverTail: boolean;
  readonly storeRead: boolean;
  readonly storeFirst: boolean;
  readonly doubleWrite: boolean;
}

export interface LocalTranscriptEntry extends Record<string, unknown> {
  id: string;
  kind: string;
}

export interface TranscriptListQuery {
  readonly beforeSeq?: number | bigint;
  readonly limit?: number;
  readonly generation?: number;
}

export interface TranscriptServerClient {
  listGrokBotTranscriptEntries(
    request: ListGrokBotTranscriptEntriesRequest,
  ): Promise<{ entries: GrokBotTranscriptEntry[]; generation: number }>;
  watchGrokBotTranscripts(
    request: WatchGrokBotTranscriptsRequest,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<GrokBotTranscriptWatchFrame>;
  commitGrokBotTranscriptEntries(
    request: CommitGrokBotTranscriptEntriesRequest,
  ): Promise<unknown>;
}

/** 0.27 main-process read path: store_read / server_tail. store_first is renderer-only. */
export function isTranscriptReadEnabled(gates: TranscriptServerGates): boolean {
  return isMainProcessTranscriptReadEnabled(gates);
}

export function resolveTranscriptGates(options: {
  checkGate?: (name: SandTranscriptGateName) => boolean;
  env?: NodeJS.ProcessEnv;
} = {}): TranscriptServerGates {
  const read = (name: SandTranscriptGateName): boolean => {
    if (options.checkGate != null) return options.checkGate(name);
    const environment = envGateOverride(name, options.env ?? process.env);
    if (environment != null) return environment;
    return FLAGS[name]?.default ?? false;
  };
  return {
    serverTail: read(SAND_TRANSCRIPT_SERVER_TAIL_GATE),
    storeRead: read(SAND_TRANSCRIPT_STORE_READ_GATE),
    storeFirst: read(SAND_TRANSCRIPT_STORE_FIRST_GATE),
    doubleWrite: read(SAND_TRANSCRIPT_DOUBLE_WRITE_GATE),
  };
}

export function decodeServerTranscriptEntry(
  entry: GrokBotTranscriptEntry,
): LocalTranscriptEntry | null {
  if (!entry.bodyOmitted && entry.body != null && entry.body.byteLength > 0) {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(entry.body));
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;
      const id = typeof record.id === "string" && record.id.length > 0
        ? record.id
        : entry.entryId != null && entry.entryId.length > 0
          ? entry.entryId
          : String(entry.seq);
      const kind = typeof record.kind === "string" && record.kind.length > 0
        ? record.kind
        : entry.entryKind.length > 0
          ? entry.entryKind
          : "message";
      return { ...record, id, kind };
    } catch {
      return null;
    }
  }
  if (entry.entryId == null || entry.entryId.length === 0) return null;
  return { id: entry.entryId, kind: entry.entryKind.length > 0 ? entry.entryKind : "message" };
}

export function encodeLocalTranscriptEntry(entry: LocalTranscriptEntry): GrokBotTranscriptEntry {
  return new GrokBotTranscriptEntry({
    seq: protoInt64.zero,
    entryKind: entry.kind,
    body: new TextEncoder().encode(JSON.stringify(entry)),
    entryId: entry.id,
    bodyOmitted: false,
  });
}

export interface TranscriptServerBridgeOptions {
  readonly gates: () => TranscriptServerGates;
  readonly client?: TranscriptServerClient | (() => TranscriptServerClient | undefined);
  readonly log?: (message: string, error?: unknown) => void;
  readonly onRows?: (agentId: string, entries: readonly LocalTranscriptEntry[]) => void;
}

export class TranscriptServerBridge {
  private readonly cache = new Map<string, LocalTranscriptEntry[]>();
  private readonly generation = new Map<string, number>();
  private readonly watches = new Map<string, AbortController>();
  private readonly log: (message: string, error?: unknown) => void;

  constructor(readonly options: TranscriptServerBridgeOptions) {
    this.log = options.log ?? ((message, error) => {
      if (error == null) console.error(message);
      else console.error(message, error);
    });
  }

  gates(): TranscriptServerGates {
    return this.options.gates();
  }

  isReadEnabled(): boolean {
    return isTranscriptReadEnabled(this.gates());
  }

  isDoubleWriteEnabled(): boolean {
    return this.gates().doubleWrite;
  }

  cachedEntries(agentId: string): LocalTranscriptEntry[] | undefined {
    return this.cache.get(agentId);
  }

  overlaySync<T extends { entries: readonly Record<string, unknown>[] }>(
    agentId: string,
    local: T,
  ): T {
    if (!this.isReadEnabled()) return local;
    const cached = this.cache.get(agentId);
    if (cached == null) return local;
    return { ...local, entries: cached };
  }

  overlayEntries(agentId: string, local: readonly Record<string, unknown>[]): LocalTranscriptEntry[] {
    const entries = this.overlaySync(agentId, { entries: [...local] }).entries;
    return entries as LocalTranscriptEntry[];
  }

  /**
   * 0.27-shaped read path: List, then overlay. Watch is not started.
   */
  async bootstrapRead(
    agentId: string,
    local: readonly LocalTranscriptEntry[],
    query?: TranscriptListQuery,
  ): Promise<LocalTranscriptEntry[]> {
    if (!this.isReadEnabled()) return [...local];
    await this.list(agentId, query);
    return this.overlayEntries(agentId, local);
  }

  /**
   * Live server read used by 0.27 `readTail`. List only; fail closed.
   */
  async readTail<T extends { entries: readonly Record<string, unknown>[] }>(
    agentId: string,
    local: T,
    query?: TranscriptListQuery,
  ): Promise<T> {
    if (!this.isReadEnabled()) return local;
    const listed = await this.list(agentId, query);
    if (listed == null) return local;
    return this.overlaySync(agentId, local);
  }

  async list(
    agentId: string,
    query?: TranscriptListQuery,
  ): Promise<LocalTranscriptEntry[] | null> {
    if (!this.isReadEnabled()) return null;
    const client = this.resolveClient();
    if (client == null) return null;
    try {
      const response = await client.listGrokBotTranscriptEntries(
        new ListGrokBotTranscriptEntriesRequest({
          agentId,
          limit: query?.limit ?? 5_000,
          ...(query?.generation != null ? { generation: query.generation } : {}),
          ...(query?.beforeSeq != null ? { beforeSeq: protoInt64.parse(query.beforeSeq) } : {}),
        }),
      );
      const entries = response.entries.flatMap((entry) => decodeServerTranscriptEntry(entry) ?? []);
      this.cache.set(agentId, entries);
      this.generation.set(agentId, response.generation);
      return entries;
    } catch (error) {
      this.log(`[sand-transcript-server] ListGrokBotTranscriptEntries failed for ${agentId}; serving local data`, error);
      return null;
    }
  }

  /**
   * Gated helper. 0.27 ships Watch unused; do not start it from List/readTail.
   */
  ensureWatch(agentId: string): void {
    if (!this.isReadEnabled()) return;
    if (this.watches.has(agentId)) return;
    const client = this.resolveClient();
    if (client == null) return;
    const abort = new AbortController();
    this.watches.set(agentId, abort);
    void this.consumeWatch(agentId, client, abort);
  }

  stopWatch(agentId: string): void {
    this.watches.get(agentId)?.abort();
    this.watches.delete(agentId);
  }

  dispose(): void {
    for (const abort of this.watches.values()) abort.abort();
    this.watches.clear();
  }

  /**
   * Gated helper. 0.27's shipped binary never calls Commit; this tree only
   * fires it when sand_transcript_double_write is on, in addition to the
   * local write.
   */
  async commit(agentId: string, entries: readonly LocalTranscriptEntry[]): Promise<void> {
    if (!this.isDoubleWriteEnabled() || entries.length === 0) return;
    const client = this.resolveClient();
    if (client == null) return;
    try {
      await client.commitGrokBotTranscriptEntries(
        new CommitGrokBotTranscriptEntriesRequest({
          agentId,
          generation: this.generation.get(agentId) ?? 0,
          entries: entries.map(encodeLocalTranscriptEntry),
        }),
      );
    } catch (error) {
      this.log(`[sand-transcript-server] CommitGrokBotTranscriptEntries failed for ${agentId}; local store unchanged`, error);
    }
  }

  private resolveClient(): TranscriptServerClient | undefined {
    const resolved = this.options.client;
    return typeof resolved === "function" ? resolved() : resolved;
  }

  private async consumeWatch(
    agentId: string,
    client: TranscriptServerClient,
    abort: AbortController,
  ): Promise<void> {
    try {
      const request = new WatchGrokBotTranscriptsRequest({
        cursors: [
          new GrokBotTranscriptCursor({
            agentId,
            generation: this.generation.get(agentId) ?? 0,
            afterUpdatedSeq: protoInt64.zero,
          }),
        ],
        inlineBodyMaxBytes: 1_048_576,
      });
      for await (const frame of client.watchGrokBotTranscripts(request, { signal: abort.signal })) {
        if (abort.signal.aborted) return;
        await this.applyWatchFrame(agentId, frame);
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      this.log(`[sand-transcript-server] WatchGrokBotTranscripts failed for ${agentId}; keeping local data`, error);
    } finally {
      if (this.watches.get(agentId) === abort) this.watches.delete(agentId);
    }
  }

  private async applyWatchFrame(agentId: string, frame: GrokBotTranscriptWatchFrame): Promise<void> {
    switch (frame.frame.case) {
      case "rows":
        this.applyRows(agentId, frame.frame.value);
        break;
      case "cleared":
        this.cache.set(agentId, []);
        this.generation.set(agentId, frame.frame.value.newGeneration);
        this.options.onRows?.(agentId, []);
        break;
      case "cursorTooOld": {
        const listed = await this.list(agentId);
        if (listed != null) this.options.onRows?.(agentId, listed);
        break;
      }
      default:
        break;
    }
  }

  private applyRows(agentId: string, rows: GrokBotTranscriptWatchRows): void {
    this.generation.set(agentId, rows.generation);
    const decoded = rows.entries.flatMap((entry) => decodeServerTranscriptEntry(entry) ?? []);
    const deleted = new Set(
      rows.deletes.map((entry) => entry.entryId).filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    const current = rows.replay ? [] : this.cache.get(agentId) ?? [];
    const byId = new Map(current.map((entry) => [entry.id, entry]));
    for (const id of deleted) byId.delete(id);
    for (const entry of decoded) byId.set(entry.id, entry);
    const next = [...byId.values()];
    this.cache.set(agentId, next);
    this.options.onRows?.(agentId, next);
  }
}

let installed: TranscriptServerBridge | undefined;

export function installTranscriptServerBridge(bridge: TranscriptServerBridge | undefined): void {
  installed?.dispose();
  installed = bridge;
}

export function getTranscriptServerBridge(): TranscriptServerBridge | undefined {
  return installed;
}

export function overlayTranscriptEntries(
  agentId: string,
  local: readonly Record<string, unknown>[],
): LocalTranscriptEntry[] {
  return installed?.overlayEntries(agentId, local) ?? (local as LocalTranscriptEntry[]);
}

export async function bootstrapTranscriptRead(
  agentId: string,
  local: readonly LocalTranscriptEntry[],
  query?: TranscriptListQuery,
): Promise<LocalTranscriptEntry[]> {
  return installed == null ? [...local] : installed.bootstrapRead(agentId, local, query);
}

export async function refreshTranscriptList(
  agentId: string,
  query?: TranscriptListQuery,
): Promise<LocalTranscriptEntry[] | null> {
  return installed == null ? null : installed.list(agentId, query);
}

export async function readTranscriptServerTail<T extends { entries: readonly Record<string, unknown>[] }>(
  agentId: string,
  local: T,
  query?: TranscriptListQuery,
): Promise<T> {
  return installed == null ? local : installed.readTail(agentId, local, query);
}

export function overlayTranscriptWindow<T extends { entries: readonly Record<string, unknown>[] }>(
  agentId: string,
  local: T,
): T {
  return installed?.overlaySync(agentId, local) ?? local;
}
