import { existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import { createContext } from "../../packages/context/core.js";
import { ConversationStateStructure } from "../../packages/proto/generated/agent/v1/agent_pb.js";
import { invariant } from "../../shared/invariant.js";
import { LegacyFileTranscriptMirror } from "../transcript-mirror/legacy-transcript-mirror.js";

interface ReadConnection {
  readonly db: DatabaseSync;
  readonly statement: StatementSync;
}

const readConnections = new Map<string, ReadConnection>();
const loggedOpenFailures = new Set<string>();

export interface TranscriptMirrorWorkerRequest {
  readonly kind: string;
  readonly requestId: number;
  readonly conversationId: string;
  readonly stateBlobId: Uint8Array;
  readonly blobDbPaths: string[];
  readonly transcriptsDir: string;
}

function toHex(blobId: Uint8Array): string {
  return Buffer.from(
    blobId.buffer,
    blobId.byteOffset,
    blobId.byteLength
  ).toString("hex");
}

function getBlobConnection(dbPath: string): ReadConnection | null {
  const cached = readConnections.get(dbPath);
  if (cached != null) return cached;
  if (!existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const connection = {
      db,
      statement: db.prepare("SELECT data FROM blobs WHERE id = ?")
    };
    readConnections.set(dbPath, connection);
    return connection;
  } catch (error) {
    if (!loggedOpenFailures.has(dbPath)) {
      loggedOpenFailures.add(dbPath);
      console.error(
        `[transcript-mirror-worker] cannot open ${dbPath} read-only:`,
        error
      );
    }
    return null;
  }
}

export class ReadOnlySqliteBlobStore {
  constructor(readonly dbPaths: readonly string[]) {}

  async getBlob(
    _ctx: unknown,
    blobId: Uint8Array
  ): Promise<Uint8Array | undefined> {
    const key = toHex(blobId);
    for (const dbPath of this.dbPaths) {
      const connection = getBlobConnection(dbPath);
      if (connection == null) continue;
      try {
        const row = connection.statement.get(key) as
          | { data?: unknown }
          | undefined;
        if (row?.data instanceof Uint8Array) return row.data;
      } catch (error) {
        console.error(
          `[transcript-mirror-worker] blob read failed in ${dbPath}:`,
          error
        );
      }
    }
    return undefined;
  }

  async setBlob(): Promise<never> {
    invariant(false, "transcript-mirror worker never writes blobs");
  }

  async setBlobLocallyOnly(): Promise<never> {
    invariant(false, "transcript-mirror worker never writes blobs");
  }

  async flush(): Promise<void> {}
}

export class MissingTranscriptStateError extends Error {}

function post(message: object): void {
  parentPort?.postMessage(message);
}

export function runTranscriptMirrorWorker(): void {
  const port = parentPort;
  if (port == null) {
    throw new Error("transcript-mirror-worker must run as a worker_thread");
  }
  port.on("message", (request: TranscriptMirrorWorkerRequest) => {
    if (request.kind === "close") {
      post({ kind: "close-ok", requestId: request.requestId });
      port.close();
      return;
    }
    void (async () => {
      try {
        const startedAt = performance.now();
        const blobStore = new ReadOnlySqliteBlobStore(request.blobDbPaths);
        const stateBinary = await blobStore.getBlob(
          createContext(),
          request.stateBlobId
        );
        if (stateBinary == null) {
          throw new MissingTranscriptStateError(
            "transcript mirror checkpoint blob is unavailable"
          );
        }
        const state = ConversationStateStructure.fromBinary(stateBinary);
        const written = await new LegacyFileTranscriptMirror(
          request.transcriptsDir
        ).writeFull(
          createContext(),
          request.conversationId,
          state,
          blobStore
        );
        post({
          kind: "mirror-write-ok",
          requestId: request.requestId,
          written,
          durationMs: performance.now() - startedAt
        });
      } catch (error) {
        post({
          kind: "error",
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    })();
  });
}

if (parentPort != null) runTranscriptMirrorWorker();
