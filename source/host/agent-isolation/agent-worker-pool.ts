import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export function defaultWorkerEntryPath(): string {
  const here =
    typeof __dirname === "string"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  return join(here, "agent-isolation", "agent-store-worker.cjs");
}

interface WorkerResponse {
  readonly kind: string;
  readonly requestId: number;
  readonly threadId?: number;
  readonly pid?: number;
  readonly blobData?: Uint8Array;
  readonly rootId?: Uint8Array;
  readonly deleted?: number;
  readonly result?: unknown;
  readonly verdict?: unknown;
  readonly message?: string;
  readonly name?: string;
  readonly code?: string;
}

interface WorkerBoot {
  readonly agentId: string;
  readonly blobDbPath: string;
  readonly busyTimeoutMs: number;
  readonly legacyBlobDbPath?: string;
}

interface PendingWorkerRequest {
  resolve(response: WorkerResponse): void;
  reject(error: Error): void;
}

export function rebuildWorkerError(
  response: Pick<WorkerResponse, "message" | "name" | "code">
): Error {
  const error = new Error(response.message);
  if (response.name != null) error.name = response.name;
  if (response.code != null) Object.assign(error, { code: response.code });
  return error;
}

export const MAX_FORWARDED_WORKER_LINE_BYTES = 8 * 1024;

export function forwardStream(
  stream: Readable | null,
  emit: (line: string) => void
): void {
  if (stream == null) return;
  let buffered = "";
  const emitLine = (line: string) => {
    if (line.length === 0) return;
    emit(
      line.length > MAX_FORWARDED_WORKER_LINE_BYTES
        ? `${line.slice(0, MAX_FORWARDED_WORKER_LINE_BYTES)}…[truncated]`
        : line
    );
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    if (buffered.length > MAX_FORWARDED_WORKER_LINE_BYTES * 2) {
      emitLine(buffered);
      buffered = "";
      return;
    }
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) emitLine(line.replace(/\r$/, ""));
  });
  const flush = () => {
    const remainder = buffered;
    buffered = "";
    emitLine(remainder);
  };
  stream.on("end", flush);
  stream.on("close", flush);
  stream.on("error", () => {});
}

export class AgentWorkerConnection {
  readonly worker: Worker;
  readonly pending = new Map<number, PendingWorkerRequest>();
  nextRequestId = 1;
  isDead = false;
  lastActivityAt = Date.now();
  workerThreadId: number | null = null;
  workerPid: number | null = null;

  constructor(
    workerEntryPath: string,
    boot: WorkerBoot,
    readonly onExit: (self: AgentWorkerConnection) => void
  ) {
    this.worker = new Worker(workerEntryPath, {
      workerData: boot,
      stdout: true,
      stderr: true
    });
    forwardStream(this.worker.stdout, message => console.log(message));
    forwardStream(this.worker.stderr, message => console.error(message));
    this.worker.on("message", response => {
      const workerResponse = response as WorkerResponse;
      const entry = this.pending.get(workerResponse.requestId);
      if (entry == null) return;
      this.pending.delete(workerResponse.requestId);
      if (workerResponse.kind === "error") {
        entry.reject(rebuildWorkerError(workerResponse));
      } else {
        entry.resolve(workerResponse);
      }
    });
    this.worker.on("error", error => this.die(error));
    this.worker.on("exit", code => {
      if (code !== 0) this.die(new Error(`worker exited with code ${code}`));
      else this.die(new Error("worker exited"));
    });
  }

  private die(reason: unknown): void {
    if (this.isDead) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.isDead = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.onExit(this);
  }

  send(
    build: (requestId: number) => object,
    transfer: readonly ArrayBuffer[] = []
  ): Promise<WorkerResponse> {
    if (this.isDead) {
      return Promise.reject(new Error("worker is no longer running"));
    }
    this.lastActivityAt = Date.now();
    const requestId = this.nextRequestId++;
    const request = build(requestId);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: response => {
          this.lastActivityAt = Date.now();
          resolve(response);
        },
        reject: error => {
          this.lastActivityAt = Date.now();
          reject(error);
        }
      });
      this.worker.postMessage(request, [...transfer]);
    });
  }

  activityAt(): number {
    return this.lastActivityAt;
  }

  threadId(): number | null {
    return this.workerThreadId;
  }

  pid(): number | null {
    return this.workerPid;
  }

  async init(boot: WorkerBoot): Promise<void> {
    const response = await this.send(requestId => ({
      kind: "init",
      requestId,
      agentId: boot.agentId,
      blobDbPath: boot.blobDbPath,
      busyTimeoutMs: boot.busyTimeoutMs
    }));
    this.workerThreadId = response.threadId as number;
    this.workerPid = response.pid as number;
  }

  async setBlob(blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    await this.send(requestId => ({
      kind: "set-blob",
      requestId,
      blobId,
      blobData
    }));
  }

  async getBlob(blobId: Uint8Array): Promise<Uint8Array | undefined> {
    const response = await this.send(requestId => ({
      kind: "get-blob",
      requestId,
      blobId
    }));
    return response.blobData;
  }

  async findLatestRootBlobId(): Promise<Uint8Array | undefined> {
    const response = await this.send(requestId => ({
      kind: "find-latest-root",
      requestId
    }));
    return response.rootId;
  }

  async clearBlobs(): Promise<void> {
    await this.send(requestId => ({ kind: "clear-blobs", requestId }));
  }

  async clearStaleCheckpointRoots(retainedRootIdHex: string): Promise<number> {
    const response = await this.send(requestId => ({
      kind: "clear-stale-roots",
      requestId,
      retainedRootIdHex
    }));
    return response.deleted as number;
  }

  async collectGarbage(
    retainedRootIdHex: string,
    pendingWriteRetentionMs: number
  ): Promise<unknown> {
    const response = await this.send(requestId => ({
      kind: "collect-garbage",
      requestId,
      retainedRootIdHex,
      pendingWriteRetentionMs
    }));
    return response.result;
  }

  async verifyLegacyBlobRetirement(
    retainedRootIdHex: string,
    legacyBlobDbPath: string
  ): Promise<unknown> {
    const response = await this.send(requestId => ({
      kind: "verify-legacy-blob-retirement",
      requestId,
      retainedRootIdHex,
      legacyBlobDbPath
    }));
    return response.verdict;
  }

  async close(): Promise<void> {
    if (this.isDead) return;
    try {
      await this.send(requestId => ({ kind: "close", requestId }));
    } catch {}
    await this.worker.terminate();
  }
}

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_MAX_WORKERS = 64;
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export interface AgentWorkerPoolOptions {
  readonly workerEntryPath?: string;
  readonly busyTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxWorkers?: number;
  readonly sweepIntervalMs?: number;
}

export class AgentWorkerPool {
  readonly workerEntryPath: string;
  readonly busyTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxWorkers: number;
  readonly sweepIntervalMs: number;
  readonly connections = new Map<string, AgentWorkerConnection>();
  readonly activeOps = new Map<string, number>();
  sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: AgentWorkerPoolOptions = {}) {
    this.workerEntryPath = options.workerEntryPath ?? defaultWorkerEntryPath();
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  async ensure(
    agentId: string,
    blobDbPath: string,
    legacyBlobDbPath?: string
  ): Promise<AgentWorkerConnection> {
    const existing = this.connections.get(blobDbPath);
    if (existing != null) return existing;
    this.evictForCapacity();
    const boot: WorkerBoot = {
      agentId,
      blobDbPath,
      busyTimeoutMs: this.busyTimeoutMs,
      ...(legacyBlobDbPath == null ? {} : { legacyBlobDbPath })
    };
    const connection = new AgentWorkerConnection(
      this.workerEntryPath,
      boot,
      self => {
        if (this.connections.get(blobDbPath) === self) {
          this.connections.delete(blobDbPath);
          if (this.connections.size === 0) this.stopSweep();
        }
      }
    );
    this.connections.set(blobDbPath, connection);
    this.startSweep();
    await connection.init(boot);
    console.log(
      `[agent-isolation] spawned worker for agent ${agentId} on thread ${connection.threadId()} (pid ${connection.pid()}, active workers: ${this.connections.size})`
    );
    return connection;
  }

  private retain(blobDbPath: string): void {
    this.activeOps.set(blobDbPath, (this.activeOps.get(blobDbPath) ?? 0) + 1);
  }

  private release(blobDbPath: string): void {
    const next = (this.activeOps.get(blobDbPath) ?? 0) - 1;
    if (next <= 0) this.activeOps.delete(blobDbPath);
    else this.activeOps.set(blobDbPath, next);
  }

  private isRetained(blobDbPath: string): boolean {
    return (this.activeOps.get(blobDbPath) ?? 0) > 0;
  }

  async setBlob(
    agentId: string,
    blobDbPath: string,
    blobId: Uint8Array,
    blobData: Uint8Array,
    legacyBlobDbPath?: string
  ): Promise<void> {
    this.retain(blobDbPath);
    try {
      const connection = await this.ensure(
        agentId,
        blobDbPath,
        legacyBlobDbPath
      );
      await connection.setBlob(blobId, blobData);
    } finally {
      this.release(blobDbPath);
    }
  }

  async getBlob(
    agentId: string,
    blobDbPath: string,
    blobId: Uint8Array,
    legacyBlobDbPath?: string
  ): Promise<Uint8Array | undefined> {
    this.retain(blobDbPath);
    try {
      const connection = await this.ensure(
        agentId,
        blobDbPath,
        legacyBlobDbPath
      );
      return await connection.getBlob(blobId);
    } finally {
      this.release(blobDbPath);
    }
  }

  async findLatestRootBlobId(args: {
    readonly agentId: string;
    readonly blobDbPath: string;
    readonly legacyBlobDbPath?: string;
  }): Promise<Uint8Array | undefined> {
    this.retain(args.blobDbPath);
    try {
      const connection = await this.ensure(
        args.agentId,
        args.blobDbPath,
        args.legacyBlobDbPath
      );
      return await connection.findLatestRootBlobId();
    } finally {
      this.release(args.blobDbPath);
    }
  }

  async clearBlobs(
    agentId: string,
    blobDbPath: string,
    legacyBlobDbPath?: string
  ): Promise<void> {
    this.retain(blobDbPath);
    try {
      const connection = await this.ensure(
        agentId,
        blobDbPath,
        legacyBlobDbPath
      );
      await connection.clearBlobs();
    } finally {
      this.release(blobDbPath);
    }
  }

  async clearStaleCheckpointRoots(
    agentId: string,
    blobDbPath: string,
    retainedRootIdHex: string,
    legacyBlobDbPath?: string
  ): Promise<number> {
    this.retain(blobDbPath);
    try {
      const connection = await this.ensure(
        agentId,
        blobDbPath,
        legacyBlobDbPath
      );
      return await connection.clearStaleCheckpointRoots(retainedRootIdHex);
    } finally {
      this.release(blobDbPath);
    }
  }

  async collectConversationGarbage(args: {
    readonly agentId: string;
    readonly blobDbPath: string;
    readonly retainedRootIdHex: string;
    readonly pendingWriteRetentionMs: number;
    readonly legacyBlobDbPath?: string;
  }): Promise<unknown> {
    this.retain(args.blobDbPath);
    try {
      const connection = await this.ensure(
        args.agentId,
        args.blobDbPath,
        args.legacyBlobDbPath
      );
      return await connection.collectGarbage(
        args.retainedRootIdHex,
        args.pendingWriteRetentionMs
      );
    } finally {
      this.release(args.blobDbPath);
    }
  }

  async verifyLegacyBlobRetirement(args: {
    readonly agentId: string;
    readonly blobDbPath: string;
    readonly retainedRootIdHex: string;
    readonly legacyBlobDbPath: string;
  }): Promise<unknown> {
    this.retain(args.blobDbPath);
    try {
      const connection = await this.ensure(
        args.agentId,
        args.blobDbPath,
        args.legacyBlobDbPath
      );
      return await connection.verifyLegacyBlobRetirement(
        args.retainedRootIdHex,
        args.legacyBlobDbPath
      );
    } finally {
      this.release(args.blobDbPath);
    }
  }

  async closeStore(blobDbPath: string): Promise<void> {
    const connection = this.connections.get(blobDbPath);
    if (connection == null) return;
    this.connections.delete(blobDbPath);
    if (this.connections.size === 0) this.stopSweep();
    await connection.close();
  }

  async closeAll(): Promise<void> {
    this.stopSweep();
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(all.map(connection => connection.close()));
  }

  activeWorkerCount(): number {
    return this.connections.size;
  }

  describeWorkers(): Array<{
    blobDbPath: string;
    threadId: number | null;
    pid: number | null;
  }> {
    return [...this.connections].map(([blobDbPath, connection]) => ({
      blobDbPath,
      threadId: connection.threadId(),
      pid: connection.pid()
    }));
  }

  private evictForCapacity(): void {
    if (this.connections.size < this.maxWorkers) return;
    let victimPath: string | null = null;
    let oldestActivity = Infinity;
    for (const [blobDbPath, connection] of this.connections) {
      if (this.isRetained(blobDbPath)) continue;
      if (connection.activityAt() < oldestActivity) {
        oldestActivity = connection.activityAt();
        victimPath = blobDbPath;
      }
    }
    if (victimPath == null) return;
    const victim = this.connections.get(victimPath);
    if (victim == null) return;
    this.connections.delete(victimPath);
    void victim.close();
  }

  private startSweep(): void {
    if (this.sweepTimer != null) return;
    if (!Number.isFinite(this.idleTimeoutMs)) return;
    const timer = setInterval(() => this.sweepIdle(), this.sweepIntervalMs);
    timer.unref();
    this.sweepTimer = timer;
  }

  private stopSweep(): void {
    if (this.sweepTimer == null) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [blobDbPath, connection] of [...this.connections]) {
      if (this.isRetained(blobDbPath)) continue;
      if (now - connection.activityAt() < this.idleTimeoutMs) continue;
      this.connections.delete(blobDbPath);
      void connection.close();
    }
    if (this.connections.size === 0) this.stopSweep();
  }
}
