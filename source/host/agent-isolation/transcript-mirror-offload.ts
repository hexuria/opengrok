import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { errorLogTag } from "../../shared/errors.js";
import { invariant } from "../../shared/invariant.js";
import { reportHostDiagnostic } from "../host-diagnostics.js";
import {
  LegacyFileTranscriptMirror,
  type LegacyTranscriptBlobStore,
  type LegacyTranscriptState
} from "../transcript-mirror/legacy-transcript-mirror.js";
import { WorkerBlobStore } from "./worker-blob-store.js";

export const DEFAULT_MIRROR_WORKERS = 2;

export function defaultMirrorWorkerEntryPath(): string {
  const hostBundleDirectory =
    typeof __dirname === "string"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  return join(
    hostBundleDirectory,
    "agent-isolation",
    "transcript-mirror-worker.cjs",
  );
}

export interface TranscriptMirrorJob {
  readonly conversationId: string;
  readonly stateBlobId: Uint8Array<ArrayBuffer>;
  readonly blobDbPaths: readonly string[];
  readonly transcriptsDir: string;
}

interface MirrorWorkerResponse {
  readonly kind: string;
  readonly requestId: number;
  readonly written?: boolean;
  readonly message?: string;
}

interface PendingMirrorRequest {
  resolve(response: MirrorWorkerResponse): void;
  reject(error: Error): void;
}

class MirrorWorkerConnection {
  readonly worker: Worker;
  readonly pending = new Map<number, PendingMirrorRequest>();
  private nextRequestId = 1;
  private dead = false;

  constructor(
    workerEntryPath: string,
    readonly onExit: (connection: MirrorWorkerConnection) => void
  ) {
    this.worker = new Worker(workerEntryPath);
    this.worker.on("message", response => {
      this.onMessage(response as MirrorWorkerResponse);
    });
    this.worker.on("error", error => this.die(error));
    this.worker.on("exit", code => {
      this.die(new Error(`mirror worker exited with code ${code}`));
    });
  }

  private onMessage(response: MirrorWorkerResponse): void {
    const entry = this.pending.get(response.requestId);
    if (entry == null) return;
    this.pending.delete(response.requestId);

    if (response.kind === "error") {
      entry.reject(new Error(response.message));
    } else {
      entry.resolve(response);
    }
  }

  private die(reason: unknown): void {
    if (this.dead) return;
    this.dead = true;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.onExit(this);
  }

  isAlive(): boolean {
    return !this.dead;
  }

  private send(
    build: (requestId: number) => object,
    transfer: ArrayBuffer[] = []
  ): Promise<MirrorWorkerResponse> {
    if (this.dead) {
      return Promise.reject(new Error("mirror worker is no longer running"));
    }

    const requestId = this.nextRequestId++;
    return new Promise<MirrorWorkerResponse>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage(build(requestId), transfer);
    });
  }

  async write(job: TranscriptMirrorJob): Promise<boolean> {
    const response = await this.send(
      requestId => ({
        kind: "mirror-write",
        requestId,
        ...job
      }),
      [job.stateBlobId.buffer]
    );
    return response.written as boolean;
  }

  async close(): Promise<void> {
    if (this.dead) return;
    try {
      await this.send(requestId => ({ kind: "close", requestId }));
    } catch {
      // A worker that died while closing has already rejected all callers.
    }
    await this.worker.terminate();
  }
}

interface MirrorResolver {
  resolve(written: boolean): void;
  reject(error: Error): void;
}

interface QueuedMirrorJob {
  job: TranscriptMirrorJob;
  readonly resolvers: MirrorResolver[];
}

interface ConversationLane {
  isRunning: boolean;
  queued: QueuedMirrorJob | null;
}

export interface TranscriptMirrorOffloadPoolOptions {
  readonly workerEntryPath?: string;
  readonly maxWorkers?: number;
}

/**
 * Consistently shards conversations across workers and serializes writes per
 * conversation. While one write is running, newer checkpoints coalesce into a
 * single queued job; every waiter resolves from that newest write.
 */
export class TranscriptMirrorOffloadPool {
  readonly workerEntryPath: string;
  readonly maxWorkers: number;
  readonly workers: Array<MirrorWorkerConnection | null>;
  readonly lanes = new Map<string, ConversationLane>();
  private isClosed = false;

  constructor(options: TranscriptMirrorOffloadPoolOptions = {}) {
    this.workerEntryPath = options.workerEntryPath ?? defaultMirrorWorkerEntryPath();
    this.maxWorkers = options.maxWorkers ?? DEFAULT_MIRROR_WORKERS;
    this.workers = new Array(this.maxWorkers).fill(null);
  }

  workerIndexFor(conversationId: string): number {
    let hash = 0;
    for (let index = 0; index < conversationId.length; index += 1) {
      hash = hash * 31 + conversationId.charCodeAt(index) | 0;
    }
    return Math.abs(hash) % this.maxWorkers;
  }

  private connectionFor(
    conversationId: string
  ): MirrorWorkerConnection {
    invariant(!this.isClosed, "mirror offload pool is closed");

    const index = this.workerIndexFor(conversationId);
    const existing = this.workers[index];
    if (existing != null && existing.isAlive()) return existing;

    const onExit = (self: MirrorWorkerConnection) => {
      if (this.workers[index] === self) this.workers[index] = null;
    };
    const connection = new MirrorWorkerConnection(this.workerEntryPath, onExit);
    this.workers[index] = connection;
    return connection;
  }

  write(job: TranscriptMirrorJob): Promise<boolean> {
    if (this.isClosed) {
      return Promise.reject(new Error("mirror offload pool is closed"));
    }

    const lane = this.lanes.get(job.conversationId) ?? {
      isRunning: false,
      queued: null
    };
    this.lanes.set(job.conversationId, lane);

    return new Promise<boolean>((resolve, reject) => {
      const resolver = { resolve, reject };
      if (lane.isRunning) {
        if (lane.queued == null) {
          lane.queued = { job, resolvers: [resolver] };
        } else {
          lane.queued.job = job;
          lane.queued.resolvers.push(resolver);
        }
        return;
      }

      lane.isRunning = true;
      void this.runJob(lane, { job, resolvers: [resolver] });
    });
  }

  private async runJob(
    lane: ConversationLane,
    entry: QueuedMirrorJob
  ): Promise<void> {
    try {
      const written = await this.connectionFor(entry.job.conversationId)
        .write(entry.job);
      for (const resolver of entry.resolvers) resolver.resolve(written);
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      for (const resolver of entry.resolvers) resolver.reject(error);
    } finally {
      const next = lane.queued;
      lane.queued = null;
      if (next != null) {
        void this.runJob(lane, next);
      } else {
        lane.isRunning = false;
        this.lanes.delete(entry.job.conversationId);
      }
    }
  }

  async closeAll(): Promise<void> {
    this.isClosed = true;
    const open = this.workers.filter(
      (worker): worker is MirrorWorkerConnection => worker != null
    );
    this.workers.fill(null);
    await Promise.all(open.map(worker => worker.close()));
  }
}

export interface InlineTranscriptMirror<State, Store> {
  writeIncremental(
    ctx: unknown,
    conversationId: string,
    state: State,
    blobStore: Store,
    previousRootPromptCount: number
  ): Promise<number | null>;
  writeFull(
    ctx: unknown,
    conversationId: string,
    state: State,
    blobStore: Store
  ): Promise<boolean>;
}

export interface OffloadingTranscriptMirrorOptions {
  readonly blobDbPaths: string[];
  readonly transcriptsDir: string;
}

function warnStaleMirror(
  conversationId: string,
  reason: "full-write-failed" | "worker-unavailable" | "worker-write-failed",
  error?: unknown
): void {
  reportHostDiagnostic({
    kind: "transcript_mirror_stale",
    agentId: conversationId,
    reason,
    ...(error === undefined ? {} : { errorClass: errorLogTag(error) })
  });
}

export class OffloadingTranscriptMirror<
  State extends { readonly rootPromptMessagesJson: readonly unknown[] },
  Store
> {
  previousRootPromptCount: number;
  private writeLane: Promise<void> = Promise.resolve();

  constructor(
    readonly inline: InlineTranscriptMirror<State, Store>,
    readonly pool: () => TranscriptMirrorOffloadPool,
    readonly options: OffloadingTranscriptMirrorOptions,
    previousRootPromptCount = 0
  ) {
    this.previousRootPromptCount = previousRootPromptCount;
  }

  static forTranscriptsDir(
    pool: () => TranscriptMirrorOffloadPool,
    options: OffloadingTranscriptMirrorOptions,
    previousRootPromptCount = 0
  ): OffloadingTranscriptMirror<LegacyTranscriptState, LegacyTranscriptBlobStore> {
    return new OffloadingTranscriptMirror(
      new LegacyFileTranscriptMirror(options.transcriptsDir),
      pool,
      options,
      previousRootPromptCount
    );
  }

  private async writeSerialized(
    ctx: unknown,
    conversationId: string,
    state: State,
    blobStore: Store,
    stateBlobId?: Uint8Array
  ): Promise<void> {
    const writtenCount = await this.inline.writeIncremental(
      ctx,
      conversationId,
      state,
      blobStore,
      this.previousRootPromptCount
    );
    if (writtenCount != null) {
      this.previousRootPromptCount = writtenCount;
      return;
    }

    if (!(blobStore instanceof WorkerBlobStore)) {
      const written = await this.inline.writeFull(
        ctx,
        conversationId,
        state,
        blobStore
      );
      if (written) {
        this.previousRootPromptCount = state.rootPromptMessagesJson.length;
      } else {
        warnStaleMirror(conversationId, "full-write-failed");
      }
      return;
    }

    if (stateBlobId == null || stateBlobId.length === 0) {
      warnStaleMirror(conversationId, "worker-unavailable");
      return;
    }

    try {
      const written = await this.pool().write({
        conversationId,
        stateBlobId: new Uint8Array(stateBlobId),
        blobDbPaths: this.options.blobDbPaths,
        transcriptsDir: this.options.transcriptsDir
      });
      if (written) {
        this.previousRootPromptCount = state.rootPromptMessagesJson.length;
      } else {
        warnStaleMirror(conversationId, "worker-write-failed");
      }
    } catch (error) {
      warnStaleMirror(conversationId, "worker-write-failed", error);
    }
  }

  write(
    ctx: unknown,
    conversationId: string,
    state: State,
    blobStore: Store,
    stateBlobId?: Uint8Array
  ): Promise<void> {
    const write = this.writeLane.then(() => this.writeSerialized(
      ctx,
      conversationId,
      state,
      blobStore,
      stateBlobId
    ));
    this.writeLane = write.then(
      () => undefined,
      () => undefined
    );
    return write;
  }
}
