import { existsSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { errorMessage } from "../../../shared/errors.js";
import { findSystemErrno } from "../../../shared/system-errno.js";
import { DB_BUSY_TIMEOUT_MS } from "../../storage/store-db.js";
import { sha256Hex } from "../../sha256.js";
import {
  BOX_STORE_BLOBS_PREFIX,
  isBoxStoreManifestFileEntry,
  type BoxStoreManifestEntry,
} from "./box-store-manifest-format.js";
import type { BoxManifestMap, BoxStoreManifestStore } from "./box-store-manifest.js";
import type { BoxObjectStore, BoxObjectStoreProvider } from "./box-object-store.js";
import { sha256File } from "./box-store-download.js";
import { sqliteVacuumInto } from "./sqlite-snapshot.js";

export type SnapshotUploadResult = {
  readonly outcome: "uploaded" | "unchanged" | "oversize" | "error";
  readonly bytesUploaded: number;
  readonly blobUploadDurationMs: number;
  readonly failurePhase?: "capture" | "blob_upload";
};

export class StoreDbSnapshotUpload {
  private readonly objectStoreProvider: BoxObjectStoreProvider;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly manifestStore: BoxStoreManifestStore;
  private readonly maxObjectBytes: number;
  private readonly largeObjectThreshold: number;
  private vacuumWorkerAvailable: boolean | undefined;

  constructor(args: {
    objectStoreProvider: BoxObjectStoreProvider;
    now: () => number;
    log: (message: string) => void;
    manifestStore: BoxStoreManifestStore;
    maxObjectBytes: number;
    largeObjectThreshold: number;
  }) {
    this.objectStoreProvider = args.objectStoreProvider;
    this.now = args.now;
    this.log = args.log;
    this.manifestStore = args.manifestStore;
    this.maxObjectBytes = args.maxObjectBytes;
    this.largeObjectThreshold = args.largeObjectThreshold;
  }

  objectStore(storeId: string): BoxObjectStore {
    return this.objectStoreProvider.forStore(storeId);
  }

  elapsedDurationMs(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }

  async uploadAgentDbSnapshot(
    storeId: string,
    manifest: BoxManifestMap,
    relPath: string,
    snapshotPath: string,
    mode: number,
  ): Promise<SnapshotUploadResult> {
    let size: number;
    try {
      size = (await stat(snapshotPath)).size;
    } catch (error) {
      this.log(`store.db ${relPath} snapshot stat failed: ${errorMessage(error)}`);
      return {
        outcome: "error",
        bytesUploaded: 0,
        blobUploadDurationMs: 0,
        failurePhase: "capture",
      };
    }
    if (size > this.maxObjectBytes) {
      this.log(`oversize ${relPath}: ${size}B over ${this.maxObjectBytes}B`);
      return {
        outcome: "oversize",
        bytesUploaded: 0,
        blobUploadDurationMs: 0,
        failurePhase: "capture",
      };
    }

    let sha: string;
    let bytes: Buffer | undefined;
    try {
      if (size >= this.largeObjectThreshold) sha = await sha256File(snapshotPath);
      else {
        bytes = await readFile(snapshotPath);
        sha = sha256Hex(bytes);
      }
    } catch (error) {
      this.log(`read failed ${relPath}: ${errorMessage(error)}`);
      return {
        outcome: "error",
        bytesUploaded: 0,
        blobUploadDurationMs: 0,
        failurePhase: "capture",
      };
    }

    const entry: BoxStoreManifestEntry = { kind: "file", sha, size, mode: mode & 0o777 };
    const existing = manifest.get(relPath);
    if (existing != null
      && isBoxStoreManifestFileEntry(existing)
      && existing.sha === sha
      && existing.size === size) {
      this.manifestStore.setManifestEntry(manifest, relPath, entry);
      return { outcome: "unchanged", bytesUploaded: 0, blobUploadDurationMs: 0 };
    }

    const uploadStartedAt = this.now();
    try {
      if (bytes === undefined) {
        await this.objectStore(storeId).putFromFile!(
          `${BOX_STORE_BLOBS_PREFIX}/${sha}`,
          snapshotPath,
          sha,
          size,
        );
      } else {
        await this.objectStore(storeId).put(
          `${BOX_STORE_BLOBS_PREFIX}/${sha}`,
          bytes,
          { contentAddressed: true },
        );
      }
    } catch (error) {
      this.log(`upload failed ${relPath}: ${errorMessage(error)}`);
      return {
        outcome: "error",
        bytesUploaded: 0,
        blobUploadDurationMs: this.elapsedDurationMs(uploadStartedAt),
        failurePhase: "blob_upload",
      };
    }
    this.manifestStore.setManifestEntry(manifest, relPath, entry);
    return {
      outcome: "uploaded",
      bytesUploaded: size,
      blobUploadDurationMs: this.elapsedDurationMs(uploadStartedAt),
    };
  }

  async runVacuumOffThread(args: { srcPath: string; destPath: string }): Promise<void> {
    const entry = defaultVacuumWorkerEntryPath();
    if (this.vacuumWorkerAvailable === undefined) {
      this.vacuumWorkerAvailable = existsSync(entry);
      if (!this.vacuumWorkerAvailable) {
        this.log(`vacuum worker bundle absent (${entry}); using in-process VACUUM`);
      }
    }
    if (this.vacuumWorkerAvailable) {
      try {
        await runVacuumInWorker({
          entryPath: entry,
          srcPath: args.srcPath,
          destPath: args.destPath,
          busyTimeoutMs: DB_BUSY_TIMEOUT_MS,
        });
        return;
      } catch (error) {
        if (!(error instanceof VacuumWorkerUnavailableError)) throw error;
        this.vacuumWorkerAvailable = false;
        this.log(`vacuum worker unavailable; using in-process VACUUM: ${errorMessage(error)}`);
      }
    }
    await this.discardSnapshotTemp({ tmpPath: args.destPath, label: "vacuum fallback pre-clean" });
    sqliteVacuumInto(args.srcPath, args.destPath);
  }

  async discardSnapshotTemp(args: { tmpPath: string; label: string }): Promise<void> {
    try {
      await unlink(args.tmpPath);
    } catch (error) {
      if (findSystemErrno(error) === "ENOENT") return;
      this.log(`temp cleanup failed ${args.label}: ${errorMessage(error)}`);
    }
  }
}

function defaultVacuumWorkerEntryPath(): string {
  const hostBundleDirectory =
    typeof __dirname === "string"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  return join(
    hostBundleDirectory,
    "extensions/box-store-sync/box-store-vacuum-worker.cjs",
  );
}

class VacuumWorkerUnavailableError extends Error {}

function runVacuumInWorker(args: {
  entryPath: string;
  srcPath: string;
  destPath: string;
  busyTimeoutMs: number;
}): Promise<void> {
  const { entryPath, srcPath, destPath, busyTimeoutMs } = args;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(entryPath);
    } catch (error) {
      reject(new VacuumWorkerUnavailableError(errorMessage(error)));
      return;
    }
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      run();
    };
    worker.on("message", (message: { ok?: boolean; message?: string }) => {
      if (message?.ok === true) finish(resolve);
      else finish(() => reject(new Error(message?.message ?? "vacuum worker reported failure")));
    });
    worker.on("error", (error) => {
      finish(() => reject(new VacuumWorkerUnavailableError(errorMessage(error))));
    });
    worker.on("exit", (code) => {
      finish(() => reject(new VacuumWorkerUnavailableError(
        `vacuum worker exited (${code}) before completing`,
      )));
    });
    worker.postMessage({ srcPath, destPath, busyTimeoutMs });
  });
}
