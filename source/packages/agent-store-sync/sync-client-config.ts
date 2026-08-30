/**
 * Defaults shared by the agent-store sync client and its BCS transport.
 *
 * This is the exact host package boundary recovered from the immutable
 * `agent-store-sync/dist/sync-client-config.js` carrier.  The transport uses
 * `rpcTimeoutMs`; the remaining values are consumed by the later sync engine
 * and are kept here so that one config object is shared across the closure.
 */

const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MULTIPART_UPLOAD_THRESHOLD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MULTIPART_PRESIGN_WINDOW_SIZE = 8;
const DEFAULT_PULL_PRESIGN_WINDOW_SIZE = 500;
const DEFAULT_MULTIPART_COMPLETE_MAX_ATTEMPTS = 3;
const DEFAULT_MULTIPART_MAX_RESTARTS = 1;
const DEFAULT_MULTIPART_MAX_CONFLICT_RENAMES = 1;
const DEFAULT_MULTIPART_MAX_EXPIRY_REFRESHES = 1;

export interface AgentStoreSyncClientConfig {
  readonly syncDebounceMs: number;
  readonly syncBackoffBaseMs: number;
  readonly syncBackoffMaxMs: number;
  readonly passiveRetryIntervalMs: number;
  readonly passiveIndexPollIntervalMs: number;
  readonly maxFileSizeBytes: number;
  readonly tokenRefreshBufferMs: number;
  readonly rpcRetryMaxAttempts: number;
  readonly rpcRetryBaseDelayMs: number;
  readonly rpcRetryMaxDelayMs: number;
  readonly rpcRetryMultiplier: number;
  readonly rpcTimeoutMs: number;
  readonly blobIdleTimeoutMs: number;
  readonly syncRoundTimeoutMs: number;
  readonly syncRoundUnwindTimeoutMs: number;
  readonly lockReleaseFailureThreshold: number;
  readonly resumeGapThresholdMs: number;
  readonly dirtyPassiveStalledThresholdMs: number;
  readonly s3Concurrency: number;
  readonly listConcurrency: number;
  readonly hashConcurrency: number;
  readonly presignConcurrency: number;
  readonly multipartUploadThresholdBytes: number;
  readonly multipartPartSizeBytes: number;
  readonly multipartPresignWindowSize: number;
  readonly pullPresignWindowSize: number;
  readonly multipartCompleteMaxAttempts: number;
  readonly multipartMaxRestarts: number;
  readonly multipartMaxConflictRenames: number;
  readonly multipartMaxExpiryRefreshes: number;
  readonly writeBarrierTimeoutMs: number;
  readonly scopedReservedSlots: number;
  readonly pathSyncRequestPollMs: number;
  readonly pathSyncRequestWaitPollMs: number;
}

export const AGENT_STORE_SYNC_CLIENT_CONFIG_DEFAULTS: AgentStoreSyncClientConfig = Object.freeze({
  syncDebounceMs: 5e3,
  syncBackoffBaseMs: 5e3,
  syncBackoffMaxMs: 6e4,
  passiveRetryIntervalMs: 5e3,
  passiveIndexPollIntervalMs: 2e3,
  maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
  tokenRefreshBufferMs: 6e4,
  rpcRetryMaxAttempts: 3,
  rpcRetryBaseDelayMs: 250,
  rpcRetryMaxDelayMs: 5e3,
  rpcRetryMultiplier: 2,
  rpcTimeoutMs: 6e4,
  blobIdleTimeoutMs: 6e4,
  syncRoundTimeoutMs: 3e5,
  syncRoundUnwindTimeoutMs: 3e4,
  lockReleaseFailureThreshold: 3,
  resumeGapThresholdMs: 12e4,
  dirtyPassiveStalledThresholdMs: 12e4,
  s3Concurrency: 8,
  listConcurrency: 4,
  hashConcurrency: 4,
  presignConcurrency: 4,
  multipartUploadThresholdBytes: DEFAULT_MULTIPART_UPLOAD_THRESHOLD_BYTES,
  multipartPartSizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES,
  multipartPresignWindowSize: DEFAULT_MULTIPART_PRESIGN_WINDOW_SIZE,
  pullPresignWindowSize: DEFAULT_PULL_PRESIGN_WINDOW_SIZE,
  multipartCompleteMaxAttempts: DEFAULT_MULTIPART_COMPLETE_MAX_ATTEMPTS,
  multipartMaxRestarts: DEFAULT_MULTIPART_MAX_RESTARTS,
  multipartMaxConflictRenames: DEFAULT_MULTIPART_MAX_CONFLICT_RENAMES,
  multipartMaxExpiryRefreshes: DEFAULT_MULTIPART_MAX_EXPIRY_REFRESHES,
  writeBarrierTimeoutMs: 2e3,
  scopedReservedSlots: 1,
  pathSyncRequestPollMs: 250,
  pathSyncRequestWaitPollMs: 50,
});
