import { parentPort, threadId, workerData } from "node:worker_threads";

import { ConversationBlobRecoveryError } from "./conversation-blob-db.js";
import { ConversationBlobStoreDb } from "./conversation-blob-store.js";

interface AgentStoreWorkerBoot {
  readonly agentId: string;
  readonly blobDbPath: string;
  readonly busyTimeoutMs?: number;
  readonly legacyBlobDbPath?: string;
}

interface AgentStoreWorkerRequest {
  readonly kind: string;
  readonly requestId: number;
  readonly blobId?: Uint8Array;
  readonly blobData?: Uint8Array;
  readonly retainedRootIdHex?: string;
  readonly pendingWriteRetentionMs?: number;
  readonly legacyBlobDbPath?: string;
}

function post(message: object, transfer: ArrayBuffer[] = []): void {
  parentPort?.postMessage(message, transfer);
}

export function runAgentStoreWorker(): void {
  const port = parentPort;
  if (port == null) {
    throw new Error("agent-store-worker must run as a worker_thread");
  }

  const boot = workerData as AgentStoreWorkerBoot;
  let store: ConversationBlobStoreDb;
  try {
    store = new ConversationBlobStoreDb({
      agentId: boot.agentId,
      blobDbPath: boot.blobDbPath,
      busyTimeoutMs: boot.busyTimeoutMs ?? 5_000,
      ...(boot.legacyBlobDbPath == null
        ? {}
        : { legacyBlobDbPath: boot.legacyBlobDbPath })
    });
  } catch (error) {
    const code = error instanceof ConversationBlobRecoveryError
      ? error.code
      : typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
        ? error.code
        : "error";
    const detail = error instanceof ConversationBlobRecoveryError
      ? ` detail=${error.message}`
      : "";
    console.error(
      `[agent-store-worker] failed to open blob db: agent=${boot.agentId} code=${code}${detail}`
    );
    process.exit(1);
    return;
  }

  port.on("message", (request: AgentStoreWorkerRequest) => {
    try {
      switch (request.kind) {
        case "init": {
          post({
            kind: "init-ok",
            requestId: request.requestId,
            threadId,
            pid: process.pid
          });
          return;
        }
        case "set-blob": {
          store.setBlob(request.blobId as Uint8Array, request.blobData as Uint8Array);
          post({ kind: "set-blob-ok", requestId: request.requestId });
          return;
        }
        case "get-blob": {
          const blobData = store.getBlob(request.blobId as Uint8Array);
          if (blobData == null) {
            post({
              kind: "get-blob-ok",
              requestId: request.requestId,
              blobData: undefined
            });
            return;
          }
          const copy = new Uint8Array(blobData.byteLength);
          copy.set(blobData);
          post(
            {
              kind: "get-blob-ok",
              requestId: request.requestId,
              blobData: copy
            },
            [copy.buffer]
          );
          return;
        }
        case "find-latest-root": {
          post({
            kind: "find-latest-root-ok",
            requestId: request.requestId,
            rootId: store.findLatestRootBlobId()
          });
          return;
        }
        case "clear-blobs": {
          store.clearBlobs();
          post({ kind: "clear-blobs-ok", requestId: request.requestId });
          return;
        }
        case "clear-stale-roots": {
          post({
            kind: "clear-stale-roots-ok",
            requestId: request.requestId,
            deleted: store.clearStaleCheckpointRoots(
              request.retainedRootIdHex as string
            )
          });
          return;
        }
        case "collect-garbage": {
          post({
            kind: "collect-garbage-ok",
            requestId: request.requestId,
            result: store.collectGarbage({
              retainedRootIdHex: request.retainedRootIdHex as string,
              pendingWriteRetentionMs: request.pendingWriteRetentionMs as number
            })
          });
          return;
        }
        case "verify-legacy-blob-retirement": {
          post({
            kind: "verify-legacy-blob-retirement-ok",
            requestId: request.requestId,
            verdict: store.verifyLegacyBlobRetirement(
              request.retainedRootIdHex as string,
              request.legacyBlobDbPath as string
            )
          });
          return;
        }
        case "flush": {
          post({ kind: "flush-ok", requestId: request.requestId });
          return;
        }
        case "close": {
          store.close();
          post({ kind: "close-ok", requestId: request.requestId });
          port.close();
          return;
        }
      }
    } catch (error) {
      const code = typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
        ? error.code
        : undefined;
      post({
        kind: "error",
        requestId: request.requestId,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error ? { name: error.name } : {}),
        ...(code == null ? {} : { code })
      });
    }
  });
}

if (parentPort != null) runAgentStoreWorker();
