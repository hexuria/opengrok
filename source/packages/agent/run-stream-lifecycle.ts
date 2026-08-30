import { PrivacyCapability } from "../redaction/classification.js";
import type { Context } from "../context/core.js";
import { createSpan } from "../context/otel.js";
import { fromRedactedConversationStateStructure } from "../redacted-protos/generated/agent/v1/agent_redacted.js";

/**
 * Action cases whose state restore must retain the agent-type transition
 * marker. This is the exact predicate used by AnysphereAgent.runStream for
 * the initial and queued action restores.
 */
const AGENT_TYPE_CHANGE_ACTIONS = new Set([
  "userMessageAction",
  "subscriptionNotificationAction",
  "goalContinuationAction",
  "resumeAction",
  "executePlanAction",
]);

export function shouldTrackAgentTypeChange(
  actionCase: string | undefined,
): boolean {
  return actionCase !== undefined && AGENT_TYPE_CHANGE_ACTIONS.has(actionCase);
}

export interface RunStreamStateHandleOptions {
  readonly shouldTrackAgentTypeChange?: boolean;
  readonly loadRootPromptBlobs?: boolean;
  readonly restoreBlobFetchConcurrency?: number | undefined;
  readonly serializeSubagentStatesAsBlobRefs?: boolean;
  readonly onRootPromptImagePresence?: (presence: unknown) => void;
}

export interface RunStreamFeatureFlags {
  readonly serializeSubagentStatesAsBlobRefs?: boolean;
  readonly agentStateRestoreBlobFetchConcurrency?: number;
}

/**
 * Adds the two runner-owned restore controls to the per-restore options while
 * preserving every call-site option supplied by runStream.
 */
export function buildRunStreamStateHandleOptions(
  options: RunStreamStateHandleOptions,
  featureFlags: RunStreamFeatureFlags | undefined,
): RunStreamStateHandleOptions {
  return {
    ...options,
    serializeSubagentStatesAsBlobRefs:
      featureFlags?.serializeSubagentStatesAsBlobRefs === true,
    restoreBlobFetchConcurrency:
      featureFlags?.agentStateRestoreBlobFetchConcurrency,
  };
}

export interface RunStreamStateUpdateHost {
  readonly blobStore: {
    flush(ctx: Context): Promise<unknown>;
  };
  readonly onStateUpdate?: (
    ctx: Context,
    state: unknown,
  ) => Promise<void> | void;
}

/**
 * Creates the exact checkpoint callback used by runStream. Blob durability is
 * ordered before the redacted state callback; failures are deliberately
 * swallowed at this boundary so a best-effort checkpoint cannot mask the
 * action result.
 */
export function createRunStreamStateUpdateWithFlush(
  host: RunStreamStateUpdateHost,
): (ctx: Context, state: unknown) => Promise<void> {
  return async (innerCtx, state) => {
    using span = createSpan(innerCtx.withName("onStateUpdateWithFlush"));
    try {
      await host.blobStore.flush(span.ctx);
      await host.onStateUpdate?.(
        span.ctx,
        fromRedactedConversationStateStructure(
          state,
          PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
          undefined,
        ),
      );
    } catch {
      // Checkpoint updates are best effort in the immutable runStream path.
    }
  };
}
