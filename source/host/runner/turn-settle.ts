import { turnEndedOnSilentToolCalls } from "./turn-shape.js";
import { StepTiming } from "../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  runTurnMemory,
  type EpisodeProgress,
  type TurnMemoryStore,
} from "./turn-memory.js";
import type { AgentProfilePromptSnapshot } from "./sand-agent-profile-prompt.js";

export class TranscriptAppendAfterCheckpointError extends Error {
  readonly isTranscriptAppendAfterCheckpointError = true;

  constructor(cause: unknown) {
    super(
      `conversation checkpoint persisted but transcript append failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "TranscriptAppendAfterCheckpointError";
  }
}

export interface TokenDetails {
  readonly usedTokens?: number;
  readonly maxTokens?: number;
}

export interface TurnCheckpoint {
  readonly summaryArchives: readonly unknown[];
  tokenDetails?: TokenDetails | undefined;
  turnTimings: StepTiming[];
}

export interface ProfileIdentity {
  readonly name: string;
  readonly description: string;
}

export type ProfilePromptSnapshot = AgentProfilePromptSnapshot;

export interface TurnSettleHost {
  readonly isSubagentRunner: boolean;
  readonly transcriptMirror?: {
    prepareCheckpoint(
      context: unknown,
      transcriptId: string,
      checkpoint: TurnCheckpoint,
      blobStore: unknown,
      finalize: boolean,
      force: boolean,
    ): Promise<void>;
    abortCheckpoint(context: unknown, transcriptId: string): Promise<void>;
    commitCheckpoint(
      context: unknown,
      transcriptId: string,
      latestRootBlobId?: string,
    ): Promise<void>;
    skipCheckpoint(
      context: unknown,
      transcriptId: string,
      checkpoint: TurnCheckpoint,
      blobStore: unknown,
    ): Promise<void>;
  };
  getTranscriptId(): string;
  getBlobStore(): unknown;
  agentStore(): {
    handleCheckpoint(context: unknown, checkpoint: TurnCheckpoint): Promise<void>;
    getMetadata(key: string): string | undefined;
  } | null;
  setLocalState(checkpoint: TurnCheckpoint): void;
  ownsRunner(): boolean;
  isRunSuperseded(): boolean;
  latestPromptMessages(): readonly unknown[];
  persistAnnouncedAgentProfile(
    snapshots: unknown,
    snapshot: ProfilePromptSnapshot,
    identity: ProfileIdentity,
  ): void;
  recordPostTurnLabeling?(input: {
    conversationId: string;
    requestId: string;
    modelName: string;
    messages: readonly unknown[];
  }): void;
  reportDiagnostic?(input: {
    kind: "labeling_failed";
    stage: "post_turn_record";
    errorClass: string;
  }): void;
}

export interface TurnSettleScope {
  readonly conversationId: string;
  readonly profilePromptSnapshots: unknown;
  readonly memoryStore?: TurnMemoryStore;
  readonly episodeProgress?: EpisodeProgress | null;
  readonly isMemorableExchange?: (prompt: string) => boolean;
}

export interface TurnSession {
  getModelId(): string;
  getExecutor(): ReturnType<import("./turn-memory.js").MemorySession["getExecutor"]>;
}

export interface CompletedTurnArgs {
  readonly finalState: TurnCheckpoint;
  readonly turnStartedAtMs: number;
  readonly hidden: boolean;
  readonly trimmedPrompt: string;
  readonly session: TurnSession;
  readonly baseContext: unknown;
  readonly requestId?: string;
}

export interface TurnResultFlags {
  readonly aborted: boolean;
  readonly quiescedForUpgrade?: boolean;
  readonly awaitingUserSelection?: boolean;
  readonly streamOutputProduced?: boolean;
}

export interface TurnSettleResult extends TurnResultFlags {
  readonly text: string;
  readonly sentMessageCount: number;
  readonly reacted: boolean;
  readonly endedOnSilentToolCalls?: boolean;
}

export function createTurnSettle(
  host: TurnSettleHost,
  scope: TurnSettleScope,
) {
  let text = "";
  let sentMessageCount = 0;
  let reacted = false;
  let endedOnSilentToolCalls = false;
  const agentMessages: string[] = [];

  const collectors = {
    collectText(delta: string): void {
      text += delta;
    },
    collectSendMessage(): void {
      sentMessageCount += 1;
    },
    collectReaction(): void {
      reacted = true;
    },
    collectAgentMessage(message: string): void {
      agentMessages.push(message);
    },
  };

  let profilePromptSnapshot: ProfilePromptSnapshot | undefined;
  let pendingProfileAnnouncement: ProfileIdentity | undefined;

  function setProfileSnapshot(snapshot: ProfilePromptSnapshot): void {
    profilePromptSnapshot = snapshot;
  }

  function noteProfileUpdateAppended(identity: ProfileIdentity): void {
    pendingProfileAnnouncement = identity;
  }

  function persistPendingProfileAnnouncement(): void {
    if (
      profilePromptSnapshot == null
      || pendingProfileAnnouncement == null
    ) return;

    host.persistAnnouncedAgentProfile(
      scope.profilePromptSnapshots,
      profilePromptSnapshot,
      pendingProfileAnnouncement,
    );
    pendingProfileAnnouncement = undefined;
  }

  let observedSummaryArchiveCount = 0;
  let transcriptPersistenceEnabled = true;
  let tokenDetailsPersistenceState:
    | { readonly kind: "fresh" }
    | {
      readonly kind: "stale";
      readonly usedTokens?: number;
      readonly maxTokens?: number;
    } = { kind: "fresh" };

  function noteBaseState(
    baseState: TurnCheckpoint,
    enableTranscriptPersistence = true,
  ): void {
    observedSummaryArchiveCount = baseState.summaryArchives.length;
    transcriptPersistenceEnabled = enableTranscriptPersistence;
  }

  function prepareCheckpointForPersistence(
    checkpoint: TurnCheckpoint,
  ): void {
    const summaryArchiveCount = checkpoint.summaryArchives.length;
    const tokenDetails = checkpoint.tokenDetails;

    if (summaryArchiveCount > observedSummaryArchiveCount) {
      observedSummaryArchiveCount = summaryArchiveCount;
      tokenDetailsPersistenceState = {
        kind: "stale",
        ...(tokenDetails?.usedTokens == null
          ? {}
          : { usedTokens: tokenDetails.usedTokens }),
        ...(tokenDetails?.maxTokens == null
          ? {}
          : { maxTokens: tokenDetails.maxTokens }),
      };
    } else if (
      tokenDetailsPersistenceState.kind === "stale"
      && (
        tokenDetails?.usedTokens
          !== tokenDetailsPersistenceState.usedTokens
        || tokenDetails?.maxTokens
          !== tokenDetailsPersistenceState.maxTokens
      )
    ) {
      tokenDetailsPersistenceState = { kind: "fresh" };
    }

    if (tokenDetailsPersistenceState.kind === "stale") {
      checkpoint.tokenDetails = undefined;
    }
  }

  async function persistCheckpoint(
    context: unknown,
    checkpoint: TurnCheckpoint,
    finalizeCheckpoint: boolean,
  ): Promise<void> {
    const transcriptMirror = host.transcriptMirror;
    const preparedTranscriptMirror = transcriptPersistenceEnabled
      ? transcriptMirror
      : undefined;

    if (preparedTranscriptMirror != null) {
      await preparedTranscriptMirror.prepareCheckpoint(
        context,
        host.getTranscriptId(),
        checkpoint,
        host.getBlobStore(),
        finalizeCheckpoint,
        finalizeCheckpoint || host.isSubagentRunner,
      );
    }

    const store = host.agentStore();
    try {
      if (store != null) {
        await store.handleCheckpoint(context, checkpoint);
      } else {
        host.setLocalState(checkpoint);
      }
    } catch (error) {
      if (preparedTranscriptMirror != null) {
        await Promise.allSettled([
          preparedTranscriptMirror.abortCheckpoint(
            context,
            host.getTranscriptId(),
          ),
        ]);
      }
      throw error;
    }

    if (preparedTranscriptMirror != null) {
      try {
        const rootBlobId = store?.getMetadata("latestRootBlobId");
        await preparedTranscriptMirror.commitCheckpoint(
          context,
          host.getTranscriptId(),
          ...(rootBlobId == null ? [] : [rootBlobId]),
        );
      } catch (error) {
        throw new TranscriptAppendAfterCheckpointError(error);
      }
    } else {
      await transcriptMirror?.skipCheckpoint(
        context,
        host.getTranscriptId(),
        checkpoint,
        host.getBlobStore(),
      );
    }
  }

  async function persistStepCheckpoint(
    context: unknown,
    checkpoint: TurnCheckpoint,
  ): Promise<void> {
    await persistCheckpoint(context, checkpoint, false);
    if (host.ownsRunner()) persistPendingProfileAnnouncement();
  }

  async function settleCompletedTurn(
    args: CompletedTurnArgs,
  ): Promise<void> {
    const turnEndedAtMs = Date.now();
    args.finalState.turnTimings.push(new StepTiming({
      timestampMs: BigInt(turnEndedAtMs),
      durationMs: BigInt(
        Math.max(0, turnEndedAtMs - args.turnStartedAtMs),
      ),
    }));

    if (!host.isSubagentRunner && !args.hidden) {
      endedOnSilentToolCalls = turnEndedOnSilentToolCalls(
        host.latestPromptMessages(),
      );
    }

    if (
      !host.isSubagentRunner
      && !args.hidden
      && host.recordPostTurnLabeling != null
    ) {
      const messages = host.latestPromptMessages();
      if (
        messages.length > 0
        && args.requestId != null
        && args.requestId !== ""
      ) {
        try {
          host.recordPostTurnLabeling({
            conversationId: scope.conversationId,
            requestId: args.requestId,
            modelName: args.session.getModelId(),
            messages,
          });
        } catch (error) {
          host.reportDiagnostic?.({
            kind: "labeling_failed",
            stage: "post_turn_record",
            errorClass: error instanceof Error
              ? error.name
              : typeof error,
          });
        }
      }
    }

    const shouldRemember =
      !host.isRunSuperseded()
      && scope.memoryStore != null
      && !args.hidden
      && args.trimmedPrompt.length > 0
      && (
        scope.memoryStore.recordMemoryEvidence != null
        || scope.isMemorableExchange?.(args.trimmedPrompt) === true
      );

    if (shouldRemember && scope.memoryStore != null) {
      const exchange = {
        user: args.trimmedPrompt,
        agent: [...agentMessages, text]
          .filter((part) => part.trim().length > 0)
          .join("\n"),
      };
      await runTurnMemory(
        scope.memoryStore,
        scope.episodeProgress,
        args.session,
        args.baseContext,
        args.turnStartedAtMs,
        exchange,
      );
    }
  }

  async function persistFinalState(
    context: unknown,
    finalState: TurnCheckpoint,
  ): Promise<void> {
    prepareCheckpointForPersistence(finalState);
    await persistCheckpoint(context, finalState, true);
    persistPendingProfileAnnouncement();
  }

  function buildResult(flags: TurnResultFlags): TurnSettleResult {
    return {
      text,
      sentMessageCount,
      reacted,
      aborted: flags.aborted,
      ...(flags.quiescedForUpgrade === true
        ? { quiescedForUpgrade: true }
        : {}),
      ...(flags.awaitingUserSelection === true
        ? { awaitingUserSelection: true }
        : {}),
      ...(endedOnSilentToolCalls
        ? { endedOnSilentToolCalls: true }
        : {}),
      ...(flags.streamOutputProduced === true
        ? { streamOutputProduced: true }
        : {}),
    };
  }

  return {
    collectors,
    setProfileSnapshot,
    noteProfileUpdateAppended,
    noteBaseState,
    prepareCheckpointForPersistence,
    persistStepCheckpoint,
    settleCompletedTurn,
    persistFinalState,
    buildResult,
  };
}
