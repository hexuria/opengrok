interface RoundSummary {
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
  readonly errors: readonly unknown[];
  readonly walkMs?: number;
  readonly hashMs?: number;
  readonly presignMs?: number;
  readonly uploadMs?: number;
  readonly listMs?: number;
  readonly downloadMs?: number;
  readonly scope?: string;
}

export const NOOP_METRICS_EMITTER = Object.freeze({
  onDiskFull() {},
  onSymlinkRefused() {},
  onNetworkError() {},
  onRoundCompleted() {},
  onRoundLifecycle() {},
  onLockEvent() {},
  onResumeDetected() {},
  onDirtyPassiveStalled() {},
  onError() {},
  onConflict() {},
  recordWriteBarrier() {},
  tokenMinted() {},
  tokenRefreshUnauthorized() {},
  tokenMintNegativeCached() {},
  tokenMintFailureCached() {},
});

export function buildRoundCompletedEvent({ agentId, summary }: { readonly agentId: string; readonly summary: RoundSummary }): Record<string, unknown> {
  return {
    agentId,
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
    errorCount: summary.errors.length,
    failed: summary.errors.length > 0,
    walkMs: summary.walkMs ?? 0,
    hashMs: summary.hashMs ?? 0,
    presignMs: summary.presignMs ?? 0,
    uploadMs: summary.uploadMs ?? 0,
    listMs: summary.listMs ?? 0,
    downloadMs: summary.downloadMs ?? 0,
    scope: summary.scope ?? "full",
  };
}
