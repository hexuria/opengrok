import { createHash } from "node:crypto";
import { classifyAgentStoreSourceId } from "./paths.js";
import { buildRoundCompletedEvent } from "./metrics-emitter.js";
import { safeNotifyListener, type ResilienceListener } from "./resilience-events.js";

interface SummaryError {
  readonly code: string;
  readonly relPath?: string | undefined;
  readonly timeoutClass?: string | undefined;
}

interface SummaryConflict {
  readonly relPath: string;
  readonly conflictRelPath: string;
}

interface Summary {
  readonly durationMs: number;
  readonly filesPushed: number;
  readonly filesPulled: number;
  readonly filesSkipped: number;
  readonly bytesPushed: number;
  readonly bytesPulled: number;
  readonly refusals: number;
  readonly filesConflicted: number;
  readonly conflictProtectionDowngrades: number;
  readonly legacyProbes: number;
  readonly pushEntriesParked: number;
  readonly pullsDeferred: number;
  readonly filesDeletedRemote: number;
  readonly filesDeletedLocal: number;
  readonly deleteConflicts: number;
  readonly scanDeletesJournaled: number;
  readonly recoveryDisarms: number;
  readonly identityRecoveryWipeFailed: number;
  readonly legacyRowsRestored: number;
  readonly listingComplete: boolean;
  readonly errors: readonly SummaryError[];
  readonly conflicts: readonly SummaryConflict[];
  readonly walkMs?: number | undefined;
  readonly hashMs?: number | undefined;
  readonly presignMs?: number | undefined;
  readonly uploadMs?: number | undefined;
  readonly listMs?: number | undefined;
  readonly downloadMs?: number | undefined;
  readonly scope?: string | undefined;
}

interface SummaryListener extends ResilienceListener {
  readonly onRoundCompleted?: ((event: unknown) => unknown) | undefined;
  readonly onError?: ((event: unknown) => unknown) | undefined;
  readonly onConflict?: ((event: unknown) => unknown) | undefined;
}

export function notifySummaryResult({
  agentId,
  summary,
  listener,
  pathHashSalt,
}: {
  readonly agentId: string;
  readonly summary: Summary;
  readonly listener?: SummaryListener | undefined;
  readonly pathHashSalt?: string | undefined;
}): void {
  if (listener === undefined) {
    return;
  }
  let firstError: unknown;
  for (const error of summary.errors) {
    try {
      dispatchError({ agentId, error, listener, pathHashSalt });
    } catch (err) {
      if (firstError === undefined) {
        firstError = err;
      }
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

function dispatchError({
  agentId,
  error,
  listener,
  pathHashSalt,
}: {
  readonly agentId: string;
  readonly error: SummaryError;
  readonly listener: SummaryListener;
  readonly pathHashSalt?: string | undefined;
}): void {
  if (error.code === "symlink_refused" || error.code === "toctou_swap_refused") {
    safeNotifyListener(listener, "onSymlinkRefused", {
      agentId,
      op: "fs_read",
      relPathHash: hashRelPath({
        relPath: error.relPath,
        salt: requirePathHashSalt(pathHashSalt),
      }),
    });
    return;
  }
  if (looksLikeDiskFull(error)) {
    safeNotifyListener(listener, "onDiskFull", {
      agentId,
      op: error.code === "fs_read_failed" ? "fs_read" : "fs_write",
    });
  }
}

function hashRelPath({ relPath, salt }: { readonly relPath?: string | undefined; readonly salt: string }): string {
  return createHash("sha256")
    .update(salt)
    .update("\0")
    .update(relPath ?? "<unknown>")
    .digest("hex")
    .slice(0, 32);
}

function requirePathHashSalt(pathHashSalt: string | undefined): string {
  if (pathHashSalt === undefined || pathHashSalt.length === 0) {
    throw new Error("notifySummaryResult: pathHashSalt is required when emitting symlink-refused events");
  }
  return pathHashSalt;
}

function looksLikeDiskFull(error: SummaryError): boolean {
  return error.code === "fs_write_failed" || error.code === "fs_read_failed";
}

export function notifySummaryMetrics({
  agentId,
  summary,
  listener,
  metricsEmitter,
  pathHashSalt,
}: {
  readonly agentId: string;
  readonly summary: Summary;
  readonly listener?: SummaryListener | undefined;
  readonly metricsEmitter?: SummaryListener | undefined;
  readonly pathHashSalt?: string | undefined;
}): void {
  let firstError: unknown;
  if (metricsEmitter !== undefined) {
    try {
      emitMetrics({ agentId, summary, metricsEmitter, pathHashSalt });
    } catch (err) {
      firstError = err;
    }
  }
  try {
    notifySummaryResult({ agentId, summary, listener, pathHashSalt });
  } catch (err) {
    if (firstError === undefined) {
      firstError = err;
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

function emitMetrics({
  agentId,
  summary,
  metricsEmitter,
  pathHashSalt,
}: {
  readonly agentId: string;
  readonly summary: Summary;
  readonly metricsEmitter: SummaryListener;
  readonly pathHashSalt?: string | undefined;
}): void {
  let firstError: unknown;
  const recordError = (err: unknown): void => {
    if (firstError === undefined) {
      firstError = err;
    }
  };
  try {
    const walkMs = summary.walkMs;
    const hashMs = summary.hashMs;
    const presignMs = summary.presignMs;
    const uploadMs = summary.uploadMs;
    const listMs = summary.listMs;
    const downloadMs = summary.downloadMs;
    const scope = summary.scope;
    const roundSummary = {
      durationMs: summary.durationMs,
      filesPushed: summary.filesPushed,
      filesPulled: summary.filesPulled,
      filesSkipped: summary.filesSkipped,
      bytesPushed: summary.bytesPushed,
      bytesPulled: summary.bytesPulled,
      refusals: summary.refusals,
      filesConflicted: summary.filesConflicted,
      conflictProtectionDowngrades: summary.conflictProtectionDowngrades,
      legacyProbes: summary.legacyProbes,
      pushEntriesParked: summary.pushEntriesParked,
      pullsDeferred: summary.pullsDeferred,
      filesDeletedRemote: summary.filesDeletedRemote,
      filesDeletedLocal: summary.filesDeletedLocal,
      deleteConflicts: summary.deleteConflicts,
      scanDeletesJournaled: summary.scanDeletesJournaled,
      recoveryDisarms: summary.recoveryDisarms,
      identityRecoveryWipeFailed: summary.identityRecoveryWipeFailed,
      legacyRowsRestored: summary.legacyRowsRestored,
      listingComplete: summary.listingComplete,
      errors: summary.errors,
      ...(walkMs === undefined ? {} : { walkMs }),
      ...(hashMs === undefined ? {} : { hashMs }),
      ...(presignMs === undefined ? {} : { presignMs }),
      ...(uploadMs === undefined ? {} : { uploadMs }),
      ...(listMs === undefined ? {} : { listMs }),
      ...(downloadMs === undefined ? {} : { downloadMs }),
      ...(scope === undefined ? {} : { scope }),
    };
    metricsEmitter.onRoundCompleted?.(buildRoundCompletedEvent({ agentId, summary: roundSummary }));
  } catch (err) {
    recordError(err);
  }
  const metricsSalt = pathHashSalt !== undefined && pathHashSalt.length > 0 ? pathHashSalt : undefined;
  if (metricsEmitter.onError !== undefined) {
    for (const error of summary.errors) {
      const event = {
        agentId,
        op: opForCode(error.code),
        errorClass: error.code,
        relPathHash: error.relPath === undefined || metricsSalt === undefined
          ? undefined
          : hashRelPath({ relPath: error.relPath, salt: metricsSalt }),
        ...(error.timeoutClass === undefined ? {} : { timeoutClass: error.timeoutClass }),
      };
      try {
        metricsEmitter.onError(event);
      } catch (err) {
        recordError(err);
      }
    }
  }
  if (metricsEmitter.onConflict !== undefined && summary.conflicts.length > 0) {
    const storeKind = classifyAgentStoreSourceId(agentId);
    for (const conflict of summary.conflicts) {
      const event = {
        agentId,
        storeKind,
        relPathHash: metricsSalt === undefined ? undefined : hashRelPath({ relPath: conflict.relPath, salt: metricsSalt }),
        conflictRelPathHash: metricsSalt === undefined ? undefined : hashRelPath({
          relPath: conflict.conflictRelPath,
          salt: metricsSalt,
        }),
      };
      try {
        metricsEmitter.onConflict(event);
      } catch (err) {
        recordError(err);
      }
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

function opForCode(code: string): string {
  switch (code) {
    case "symlink_refused":
    case "toctou_swap_refused":
    case "fs_read_failed":
      return "fs_read";
    case "fs_write_failed":
      return "fs_write";
    case "upload_failed":
    case "write_conflict":
      return "blob_put";
    case "delete_failed":
      return "delete_files";
    case "download_failed":
      return "blob_get";
    default:
      return "unknown";
  }
}
