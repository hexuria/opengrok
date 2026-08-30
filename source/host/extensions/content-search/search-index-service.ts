import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";
import { errorLogTag } from "../../../shared/errors.js";
import { SQLITE_DB_SIDECAR_SUFFIXES } from "../../storage/store-db.js";
import { isSqliteCorruptError } from "../../storage/sqlite-busy.js";
import {
  ensureSearchIndexSchema,
  openSearchIndexDb,
  readReconcileDone,
  readSearchIndexSchemaVersion,
  SEARCH_INDEX_SCHEMA_VERSION,
  searchMedia,
  searchMessages,
  stampSearchIndexSchemaVersion,
} from "./search-index-db.js";
import type { IndexEntry, SearchIndexJob } from "./search-index-writer.js";

export const MAX_INDEX_REBUILDS = 3;
export const MAX_WORKER_RESPAWNS = 3;
export const MAX_FAILED_JOB_RECONCILES = 3;
export const SEARCH_INDEX_DISPOSE_TIMEOUT_MS = 2_000;

export interface SearchIndexJobFailure {
  readonly ok: false;
  readonly message: string;
  readonly isIndexCorrupt: boolean;
  readonly isWorkerUnavailable: boolean;
}

export type SearchIndexJobResult = { readonly ok: true } | SearchIndexJobFailure;

export interface SearchIndexJobPort {
  post(job: SearchIndexJob): Promise<SearchIndexJobResult>;
  terminate(): Promise<void>;
}

export function defaultWorkerEntryPath(): string {
  const hostBundleDirectory =
    typeof __dirname === "string"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  return join(
    hostBundleDirectory,
    "extensions",
    "content-search",
    "search-index-worker.cjs",
  );
}

export class WorkerSearchIndexJobPort implements SearchIndexJobPort {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    (result: SearchIndexJobResult) => void
  >();
  private nextRequestId = 1;
  private isDead = false;

  constructor(
    entryPath: string,
    config: { indexDbPath: string; agentsRootDir: string },
  ) {
    this.worker = new Worker(entryPath, { workerData: config });
    this.worker.on(
      "message",
      (response: {
        requestId: number;
        ok: boolean;
        message?: string;
        isIndexCorrupt?: boolean;
      }) => {
        const settle = this.pending.get(response.requestId);
        if (settle == null) return;
        this.pending.delete(response.requestId);
        settle(
          response.ok
            ? { ok: true }
            : {
                ok: false,
                message: response.message ?? "search index job failed",
                isIndexCorrupt: response.isIndexCorrupt === true,
                isWorkerUnavailable: false,
              },
        );
      },
    );
    this.worker.on("error", (error) =>
      this.die(error instanceof Error ? error : new Error(String(error))),
    );
    this.worker.on(
      "exit",
      (code) => this.die(new Error(`search-index worker exited (${code})`)),
    );
  }

  private die(error: Error): void {
    if (this.isDead) return;
    this.isDead = true;
    const failure: SearchIndexJobFailure = {
      ok: false,
      message: error.message,
      isIndexCorrupt: false,
      isWorkerUnavailable: true,
    };
    for (const settle of this.pending.values()) settle(failure);
    this.pending.clear();
  }

  post(job: SearchIndexJob): Promise<SearchIndexJobResult> {
    if (this.isDead) {
      return Promise.resolve({
        ok: false,
        message: "search-index worker is no longer running",
        isIndexCorrupt: false,
        isWorkerUnavailable: true,
      });
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.worker.postMessage({ requestId, job });
    });
  }

  async terminate(): Promise<void> {
    this.die(new Error("search-index worker terminated"));
    await this.worker.terminate();
  }
}

export type TranscriptMutation =
  | {
      readonly kind: "entries-upserted";
      readonly agentId: string;
      readonly entries: readonly IndexEntry[];
    }
  | {
      readonly kind: "entry-deleted";
      readonly agentId: string;
      readonly entryId: string;
    }
  | {
      readonly kind: "conversation-cleared" | "agent-removed" | "agent-needs-reindex";
      readonly agentId: string;
    };

export interface SearchIndexHealth {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export class SandSearchIndexService {
  private readonly indexDbPath: string;
  private readonly agentsRootDir: string;
  private readonly createJobPort: (
    config: { indexDbPath: string; agentsRootDir: string },
  ) => SearchIndexJobPort;
  private readonly disposeDeadline: {
    run<T>(operation: () => Promise<T>): Promise<T>;
  };
  private readonly report: (health: SearchIndexHealth) => void;
  private db: DatabaseSync | undefined;
  private port: SearchIndexJobPort | undefined;
  private isUnavailable = false;
  private isDisposed = false;
  private isReconcileDone = false;
  private isRebuildPending = false;
  private pendingReindexCount = 0;
  private rebuildCount = 0;
  private workerRespawnCount = 0;
  private failedJobReconcileCount = 0;
  private jobTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly indexDbPath: string;
    readonly agentsRootDir: string;
    readonly createJobPort?: (
      config: { indexDbPath: string; agentsRootDir: string },
    ) => SearchIndexJobPort;
    readonly workerEntryPath?: string;
    readonly disposeDeadline: {
      run<T>(operation: () => Promise<T>): Promise<T>;
    };
    readonly report?: (health: SearchIndexHealth) => void;
  }) {
    this.indexDbPath = options.indexDbPath;
    this.agentsRootDir = options.agentsRootDir;
    this.disposeDeadline = options.disposeDeadline;
    this.report = options.report ?? (() => {});
    const entryPath = options.workerEntryPath ?? defaultWorkerEntryPath();
    this.createJobPort =
      options.createJobPort ??
      ((config) => new WorkerSearchIndexJobPort(entryPath, config));
  }

  start(): void {
    if (this.isDisposed || this.isUnavailable) return;
    if (this.db == null) {
      try {
        this.db = this.openAndMigrate();
      } catch (error) {
        this.markUnavailable("open", error);
        return;
      }
      this.isReconcileDone = this.safeReadReconcileDone();
    }
    this.enqueue({ kind: "reconcile" });
  }

  get isSearchReady(): boolean {
    return (
      this.db != null &&
      !this.isUnavailable &&
      this.isReconcileDone &&
      this.pendingReindexCount === 0
    );
  }

  searchMessages(query: string, limit: number) {
    const db = this.db;
    if (db == null || this.isUnavailable) return null;
    try {
      return searchMessages(db, query, limit);
    } catch (error) {
      this.handleIndexFailure("search-messages", error);
      return null;
    }
  }

  searchMedia(query: string, limit: number) {
    const db = this.db;
    if (db == null || this.isUnavailable) return null;
    try {
      return searchMedia(db, query, limit);
    } catch (error) {
      this.handleIndexFailure("search-media", error);
      return null;
    }
  }

  applyMutation(mutation: TranscriptMutation): void {
    switch (mutation.kind) {
      case "entries-upserted":
        this.entriesUpserted(mutation.agentId, mutation.entries);
        return;
      case "entry-deleted":
        this.entryDeleted(mutation.agentId, mutation.entryId);
        return;
      case "conversation-cleared":
        this.conversationCleared(mutation.agentId);
        return;
      case "agent-removed":
        this.agentRemoved(mutation.agentId);
        return;
      case "agent-needs-reindex":
        this.agentNeedsReindex(mutation.agentId);
        return;
      default: {
        const exhaustive = mutation;
        return exhaustive;
      }
    }
  }

  private entriesUpserted(agentId: string, entries: readonly IndexEntry[]): void {
    if (entries.length === 0) return;
    this.enqueue({ kind: "upsert-entries", agentId, entries });
  }

  private entryDeleted(agentId: string, entryId: string): void {
    this.enqueue({ kind: "delete-entry", agentId, entryId });
  }

  private conversationCleared(agentId: string): void {
    this.enqueue({ kind: "clear-agent", agentId });
  }

  private agentRemoved(agentId: string): void {
    this.enqueue({ kind: "clear-agent", agentId });
  }

  private agentNeedsReindex(agentId: string): void {
    if (this.isDisposed || this.isUnavailable || this.db == null) return;
    this.pendingReindexCount += 1;
    this.enqueue({ kind: "reindex-agents", agentIds: [agentId] });
  }

  whenIdle(): Promise<void> {
    return this.jobTail;
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    await this.disposeDeadline
      .run(async () => await this.jobTail)
      .catch((error) => {
        this.report({ kind: "dispose_drain_cut", errorClass: errorLogTag(error) });
      });
    await this.terminateWorker(this.port, "dispose");
    this.port = undefined;
    try {
      this.db?.close();
    } catch {}
    this.db = undefined;
  }

  private async terminateWorker(
    port: SearchIndexJobPort | undefined,
    stage: string,
  ): Promise<void> {
    if (port == null) return;
    await port.terminate().catch((error) => {
      this.report({ kind: "worker_terminate_failed", stage, errorClass: errorLogTag(error) });
    });
  }

  private markUnavailable(stage: string, error: unknown): void {
    this.isUnavailable = true;
    const port = this.port;
    this.port = undefined;
    void this.terminateWorker(port, "unavailable teardown");
    try {
      this.db?.close();
    } catch {}
    this.db = undefined;
    this.report({ kind: "unavailable", stage, errorClass: errorLogTag(error) });
  }

  private safeReadReconcileDone(): boolean {
    const db = this.db;
    if (db == null) return false;
    try {
      return readReconcileDone(db);
    } catch {
      return false;
    }
  }

  private openAndMigrate(): DatabaseSync {
    mkdirSync(dirname(this.indexDbPath), { recursive: true });
    let db: DatabaseSync;
    try {
      db = openSearchIndexDb(this.indexDbPath);
      ensureSearchIndexSchema(db);
    } catch (error) {
      if (isFts5MissingError(error)) throw error;
      return this.recreateIndexFile();
    }
    if (readSearchIndexSchemaVersion(db) !== SEARCH_INDEX_SCHEMA_VERSION) {
      const isFreshFile =
        readSearchIndexSchemaVersion(db) === 0 && this.countIndexedMessages(db) === 0;
      if (isFreshFile) {
        stampSearchIndexSchemaVersion(db);
        return db;
      }
      try {
        db.close();
      } catch {}
      return this.recreateIndexFile();
    }
    return db;
  }

  private recreateIndexFile(): DatabaseSync {
    this.removeIndexFiles();
    const db = openSearchIndexDb(this.indexDbPath);
    ensureSearchIndexSchema(db);
    stampSearchIndexSchemaVersion(db);
    return db;
  }

  private removeIndexFiles(): void {
    for (const suffix of ["", ...SQLITE_DB_SIDECAR_SUFFIXES]) {
      rmSync(`${this.indexDbPath}${suffix}`, { force: true });
    }
  }

  private countIndexedMessages(db: DatabaseSync): number {
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM messages").get() as
        | { count?: unknown }
        | undefined;
      return typeof row?.count === "number" ? row.count : 0;
    } catch {
      return 0;
    }
  }

  private handleIndexFailure(stage: string, error: unknown): void {
    if (this.isDisposed || this.isUnavailable) return;
    if (isSqliteCorruptError(error)) {
      this.scheduleRebuild(stage, error);
      return;
    }
    this.report({ kind: "stage_failed", stage, errorClass: errorLogTag(error) });
  }

  private scheduleRebuild(stage: string, error: unknown): void {
    if (this.isDisposed || this.isUnavailable || this.isRebuildPending) return;
    this.rebuildCount += 1;
    if (this.rebuildCount > MAX_INDEX_REBUILDS) {
      this.markUnavailable(stage, error);
      return;
    }
    this.report({ kind: "corrupt_rebuild", stage, count: this.rebuildCount });
    this.isReconcileDone = false;
    this.isRebuildPending = true;
    const port = this.port;
    this.port = undefined;
    this.jobTail = this.jobTail
      .then(async () => {
        await this.terminateWorker(port, "rebuild");
        try {
          this.db?.close();
        } catch {}
        this.db = this.recreateIndexFile();
      })
      .catch((rebuildError) => this.markUnavailable("rebuild", rebuildError))
      .finally(() => {
        this.isRebuildPending = false;
      });
    this.enqueue({ kind: "reconcile" });
  }

  private getPort(): SearchIndexJobPort {
    if (this.port == null) {
      this.port = this.createJobPort({
        indexDbPath: this.indexDbPath,
        agentsRootDir: this.agentsRootDir,
      });
    }
    return this.port;
  }

  private enqueue(job: SearchIndexJob): void {
    if (this.isDisposed || this.isUnavailable || this.db == null) return;
    this.jobTail = this.jobTail
      .then(() => this.runJob(job))
      .catch((error) => {
        this.report({ kind: "dispatch_failed", errorClass: errorLogTag(error) });
      });
  }

  private async runJob(job: SearchIndexJob): Promise<void> {
    try {
      await this.dispatchJob(job);
    } finally {
      if (job.kind === "reindex-agents") {
        this.pendingReindexCount = Math.max(0, this.pendingReindexCount - 1);
      }
    }
  }

  private async dispatchJob(job: SearchIndexJob): Promise<void> {
    if (this.isDisposed || this.isUnavailable || this.db == null) return;
    const result = await this.getPort().post(job);
    if (result.ok) {
      if (job.kind === "reconcile") this.isReconcileDone = true;
      return;
    }
    if (result.isIndexCorrupt) {
      this.scheduleRebuild(`job-${job.kind}`, new Error(result.message));
      return;
    }
    if (result.isWorkerUnavailable) {
      this.port = undefined;
      this.workerRespawnCount += 1;
      if (this.workerRespawnCount > MAX_WORKER_RESPAWNS) {
        this.markUnavailable("worker-respawn", new Error(result.message));
        return;
      }
      this.report({ kind: "worker_respawn", count: this.workerRespawnCount });
      this.isReconcileDone = false;
      this.enqueue({ kind: "reconcile" });
      return;
    }
    this.failedJobReconcileCount += 1;
    if (this.failedJobReconcileCount > MAX_FAILED_JOB_RECONCILES) {
      this.markUnavailable(`job-${job.kind}`, new Error(result.message));
      return;
    }
    if (job.kind === "reindex-agents") {
      this.report({ kind: "job_retry", stage: job.kind, count: this.failedJobReconcileCount });
      this.pendingReindexCount += 1;
      this.enqueue(job);
      return;
    }
    this.report({ kind: "job_reconcile", stage: job.kind, count: this.failedJobReconcileCount });
    this.isReconcileDone = false;
    this.enqueue({ kind: "reconcile" });
  }
}

function isFts5MissingError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("no such module: fts5");
}
