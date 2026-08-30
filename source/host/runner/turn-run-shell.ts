import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Context } from "../../packages/context/core.js";
import type { PrivacyMode } from "../../packages/redaction/privacy-mode.js";
import { SAND_SUMMARIZATION_MODEL_ID } from "../../shared/agents/sand-agent-model.js";
import type { DiskPressureReminderEpisodes } from "../extensions/forever-box/disk-pressure.js";
import {
  createDiskPressureReminderMiddleware,
  createSendMessageReminderMiddleware,
  type MessageLike,
  type PromptExecutor,
} from "./send-message-reminder-middleware.js";
import { createStartOfTurnAckReminderMiddleware } from "./start-of-turn-ack-reminder-middleware.js";
import { SimplePromptToolExecutor } from "../../packages/agent/tool-stream-executor.js";
import {
  createShellWatchGeneratedStateProjection,
  createShellWatchReadAccessor,
  type ConfirmedUserTurnWatermark,
  type ShellTerminalWatchHost,
  type ShellWatchGeneratedStateOwner,
  type ShellWatchResourceAccessor,
} from "./shell-terminal-watch.js";
import type {
  TurnAgentScope,
  TurnAgentSessions,
} from "./turn-agent-composition.js";
import type {
  PromptSnapshotStore,
} from "./system-prompt-assembly.js";
import type { SummarizationPromptSession } from "../../packages/agent-summarization/summarization-handler.js";
import { createProviderPromptSession } from "../extensions/inference/provider-session.js";
import { getSandRootDir } from "../host-paths.js";
import { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import type { AgentProfilePromptSnapshot } from "./sand-agent-profile-prompt.js";
import {
  ConversationAction,
  ResumeAction,
} from "../../packages/proto/generated/agent/v1/agent_pb.js";
import type { BlobStore } from "../../packages/agent-kv/blob-store.js";
import {
  createTurnSettle,
  type TurnCheckpoint,
  type TurnSession,
  type TurnSettleHost,
  type TurnSettleResult,
} from "./turn-settle.js";
import type {
  InactiveTurnAgentStreamPath,
  InactiveTurnAgentStreamLifecycleInput,
  InactiveTurnAgentStreamStartInput,
} from "./inactive-turn-agent-stream.js";

export interface TurnAgentPromptSession {
  getModelId(): string;
  getExecutor(state?: unknown): PromptExecutor;
}

export interface TurnAgentInferenceOwner {
  resolvePrivacyMode(): Promise<PrivacyMode> | PrivacyMode;
  createSession(
    onRequestId: (requestId: string) => void,
    options?: Readonly<Record<string, unknown>>,
  ): TurnAgentPromptSession;
  createSummarizationSession?(
    onRequestId: (requestId: string) => void,
    options?: Readonly<Record<string, unknown>>,
  ): SummarizationPromptSession;
}

export interface TurnAgentShellWatchInput<ContextValue> {
  readonly box: {
    ensureReady(
      context: ContextValue,
      conversationId: string,
    ): Promise<{
      readonly terminalsFolder: string;
      readonly remoteAccessor: ShellWatchResourceAccessor<ContextValue>;
    }>;
  };
  readonly generatedState: ShellWatchGeneratedStateOwner<ContextValue>;
  readonly getConfirmedUserTurnWatermarkCache: () =>
    | ConfirmedUserTurnWatermark
    | undefined;
  readonly setConfirmedUserTurnWatermarkCache: (
    cache: ConfirmedUserTurnWatermark,
  ) => void;
  readonly now?: () => number;
}

export interface TurnAgentRunContextInput<ContextValue> {
  readonly context: ContextValue;
  readonly conversationId: string;
  readonly requestId: string;
  readonly inference: TurnAgentInferenceOwner;
  readonly onRequestId: (requestId: string) => void;
  readonly modelId?: string;
  readonly requestSource?: string;
  readonly isSubagentRunner: boolean;
  readonly isSilenceAllowed: boolean;
  readonly isComputerUseSubagent?: boolean;
  readonly isBrowserUseSubagent?: boolean;
  readonly hidden?: boolean;
  readonly lineage?: unknown;
  readonly canUseSelfSummary: () => boolean;
  readonly diskPressureReminder?: DiskPressureReminderEpisodes;
  readonly diskPressureClaimId?: string;
  readonly cancelThisRun: (reason: TurnCancellation) => void;
  readonly ackToken?: string;
  readonly pauseThisRun?: () => void;
  readonly isRunAwaitingUserSelection?: () => boolean;
  readonly endThisRunAwaitingUser?: (reason: string) => void;
  readonly quietOrigin?: unknown;
  readonly directionEpoch?: number;
  readonly profilePromptSnapshot?: AgentProfilePromptSnapshot;
  /** The released profile/system-prompt owner; prompt assembly stays there. */
  readonly systemPromptAssembly?: Pick<
    ReturnType<
      typeof import("./system-prompt-assembly.js").createSystemPromptAssembly
    >,
    "prepareAgentProfilePromptSnapshot" | "getAgentProfileUpdateForTurn"
  >;
  readonly profilePromptSnapshotStore?: PromptSnapshotStore;
  readonly onProfileUpdateAppended?: (identity: {
    readonly name: string;
    readonly description: string;
  }) => void;
  readonly emittedConnectorCards: Set<string>;
  readonly diskPressureReminderEpisodeId?: string | null;
  readonly shellWatch?: TurnAgentShellWatchInput<ContextValue>;
  readonly onLatestPromptMessages?: (
    getter: () => readonly MessageLike[],
  ) => void;
}

export interface TurnAgentRunContext<ContextValue> {
  readonly privacyMode: PrivacyMode;
  readonly sessions: TurnAgentSessions;
  readonly scope: TurnAgentScope;
  readonly toolSession: {
    getExecutor(...args: readonly unknown[]): SimplePromptToolExecutor;
  };
  readonly summarizationSession?: SummarizationPromptSession;
  readonly shellWatchHost?: ShellTerminalWatchHost<ContextValue>;
  readonly diskPressureReminderEpisodeId: string | null;
  readonly profilePromptSnapshot?: unknown;
  readonly profileUpdateForTurn?: {
    readonly text: string;
    readonly identity: { readonly name: string; readonly description: string };
  };
  commitDiskPressureReminder(): void;
  dispose(): void;
}

/**
 * Reconstructs the immutable pre-buildAgentForRun owner. Session creation,
 * privacy resolution, disk-pressure episode claiming, scope identity, and
 * shell-watch state/blob/box wiring all happen once per turn; disposal is
 * idempotent and releases an uncommitted reminder episode.
 */
export async function createTurnAgentRunContext<ContextValue>(
  input: TurnAgentRunContextInput<ContextValue>,
): Promise<TurnAgentRunContext<ContextValue>> {
  const privacyMode = await input.inference.resolvePrivacyMode();
  const diskPressureReminderEpisodeId = input.diskPressureReminder == null
    || input.diskPressureClaimId == null
    ? input.diskPressureReminderEpisodeId ?? null
    : input.diskPressureReminder.claim({
      agentId: input.conversationId,
      claimId: input.diskPressureClaimId,
    });
  const sessionOptions = {
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.isComputerUseSubagent === undefined
      ? {}
      : { isComputerUseSubagent: input.isComputerUseSubagent }),
    ...(input.isBrowserUseSubagent === undefined
      ? {}
      : { isBrowserUseSubagent: input.isBrowserUseSubagent }),
    ...(input.requestSource === undefined
      ? {}
      : { requestSource: input.requestSource }),
    skipLabeling: input.isSubagentRunner || input.hidden === true,
    ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
  };
  const inferenceProvider = new SandSettingsStore(join(getSandRootDir(), "settings.json")).getInferenceProvider();
  const agent = inferenceProvider === "cursor"
    ? input.inference.createSession(input.onRequestId, sessionOptions)
    : createProviderPromptSession(inferenceProvider) as unknown as TurnAgentPromptSession;
  const summarizationSession = inferenceProvider === "cursor" ? input.inference.createSummarizationSession?.(
    input.onRequestId,
    {
      modelId: SAND_SUMMARIZATION_MODEL_ID,
      isSummarizationSession: true,
      ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
    },
  ) : createProviderPromptSession(inferenceProvider) as unknown as SummarizationPromptSession;
  const summarization = summarizationSession ?? input.inference.createSession(
    input.onRequestId,
    {
      modelId: SAND_SUMMARIZATION_MODEL_ID,
      isSummarizationSession: true,
      ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
    },
  );
  const profilePromptSnapshot = input.profilePromptSnapshot
    ?? input.systemPromptAssembly?.prepareAgentProfilePromptSnapshot(
      input.profilePromptSnapshotStore,
    );
  const profileUpdateForTurn = input.systemPromptAssembly?.getAgentProfileUpdateForTurn(
    profilePromptSnapshot,
  );
  const baseExecutor = (): PromptExecutor => agent.getExecutor();
  const toolSession = {
    getExecutor: () => {
      const withDiskPressure = diskPressureReminderEpisodeId == null
        ? baseExecutor()
        : createDiskPressureReminderMiddleware(
          diskPressureReminderEpisodeId,
        )(baseExecutor());
      const withSendMessage = input.isSubagentRunner || input.isSilenceAllowed
        ? withDiskPressure
        : createSendMessageReminderMiddleware()(withDiskPressure);
      const executor = input.isSubagentRunner || input.isSilenceAllowed
        ? withSendMessage
        : createStartOfTurnAckReminderMiddleware()(withSendMessage);
      const toolExecutor = new SimplePromptToolExecutor(executor);
      input.onLatestPromptMessages?.(() => toolExecutor.getMessages());
      return toolExecutor;
    },
  };
  const scope: TurnAgentScope = {
    isSilenceAllowed: input.isSilenceAllowed,
    privacyMode,
    ...(input.quietOrigin === undefined ? {} : { quietOrigin: input.quietOrigin }),
    ...(input.directionEpoch === undefined
      ? {}
      : { directionEpoch: input.directionEpoch }),
    cancelThisRun: input.cancelThisRun,
    ...(input.ackToken === undefined ? {} : { ackToken: input.ackToken }),
    ...(input.pauseThisRun === undefined
      ? {}
      : { pauseThisRun: input.pauseThisRun }),
    ...(input.isRunAwaitingUserSelection === undefined
      ? {}
      : { isRunAwaitingUserSelection: input.isRunAwaitingUserSelection }),
    ...(input.endThisRunAwaitingUser === undefined
      ? {}
      : { endThisRunAwaitingUser: input.endThisRunAwaitingUser }),
    ...(profilePromptSnapshot === undefined
      ? {}
      : { profilePromptSnapshot }),
    ...(input.onProfileUpdateAppended === undefined
      ? {}
      : { onProfileUpdateAppended: input.onProfileUpdateAppended }),
    diskPressureReminderEpisodeId,
    ...(profilePromptSnapshot === undefined ? {} : { profilePromptSnapshot }),
    ...(profileUpdateForTurn == null ? {} : { profileUpdateForTurn }),
    emittedConnectorCards: input.emittedConnectorCards,
  };
  const shellWatchHost = input.shellWatch === undefined
    ? undefined
    : {
        ctx: input.context,
        ...createShellWatchGeneratedStateProjection(input.shellWatch.generatedState),
        getConversationId: () => input.conversationId,
        ensureBoxReady: async (context: ContextValue, conversationId: string) => {
          const connection = await input.shellWatch!.box.ensureReady(
            context,
            conversationId,
          );
          return {
            terminalsFolder: connection.terminalsFolder,
            remoteAccessor: createShellWatchReadAccessor(connection.remoteAccessor),
          };
        },
        getConfirmedUserTurnWatermarkCache:
          input.shellWatch.getConfirmedUserTurnWatermarkCache,
        setConfirmedUserTurnWatermarkCache:
          input.shellWatch.setConfirmedUserTurnWatermarkCache,
        ...(input.shellWatch.now === undefined
          ? {}
          : { now: input.shellWatch.now }),
      } satisfies ShellTerminalWatchHost<ContextValue>;
  let committed = false;
  let disposed = false;
  return {
    privacyMode,
    sessions: {
      agent,
      summarization,
      canUseSelfSummary: input.canUseSelfSummary,
    },
    scope,
    toolSession,
    ...(summarizationSession === undefined ? {} : { summarizationSession }),
    ...(shellWatchHost === undefined ? {} : { shellWatchHost }),
    diskPressureReminderEpisodeId,
    ...(profilePromptSnapshot === undefined ? {} : { profilePromptSnapshot }),
    ...(profileUpdateForTurn == null ? {} : { profileUpdateForTurn }),
    commitDiskPressureReminder() {
      if (disposed || committed || diskPressureReminderEpisodeId == null) return;
      committed = input.diskPressureReminder?.commit({
        agentId: input.conversationId,
        claimId: input.diskPressureClaimId ?? input.requestId,
      }) ?? false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!committed && diskPressureReminderEpisodeId != null) {
        input.diskPressureReminder?.release({
          agentId: input.conversationId,
          claimId: input.diskPressureClaimId ?? input.requestId,
        });
      }
    },
  };
}

export class SandEmptyPromptError extends Error {
  constructor() {
    super("Prompt cannot be empty.");
  }
}

export class SandTurnInterruptedBeforeDispatchError extends Error {
  constructor() {
    super("Turn interrupted before dispatch");
    this.name = "SandTurnInterruptedBeforeDispatchError";
  }
}

export const RESUME_TURN_ACTION = new ConversationAction({
  action: { case: "resumeAction", value: new ResumeAction() },
});

export interface TurnRunOptions {
  readonly requestSource?: string;
  readonly automationWake?: { readonly id: string };
  readonly selectedImages?: readonly unknown[];
  readonly attachedFilePaths?: readonly string[];
  readonly selectedVideos?: readonly unknown[];
  readonly inferenceRequestId?: string;
  readonly ackToken?: string;
  readonly messageId?: string;
  readonly recentUserMessages?: readonly {
    readonly id: string;
    readonly text: string;
  }[];
  readonly replyContext?: unknown;
  readonly hidden?: boolean;
  readonly isSilenceAllowed?: boolean;
  readonly autoReviewEpoch?: "continue" | "new";
  readonly lineage?: {
    readonly parentRequestId: string;
    readonly rootParentRequestId: string;
    readonly parentAgentToolCallId?: string;
  };
}

export interface TurnCancellation {
  readonly intentional: boolean;
  readonly reason: string;
}

export interface TurnRunContext {
  readonly signal: AbortSignal;
  readonly requestId: string;
  readonly generation: number;
  readonly privacyMode?: unknown;
  readonly inferenceSession?: TurnSession;
  readonly boxConnection?: unknown;
  readonly mcpTools?: readonly unknown[];
}

export interface PreparedTurn {
  readonly action: unknown;
  readonly baseState: TurnCheckpoint;
  readonly transcriptPersistenceEnabled: boolean;
  readonly session: TurnSession;
}

export interface TurnStreamCallbacks {
  collectText(delta: string): void;
  collectSendMessage(): void;
  collectReaction(): void;
  collectAgentMessage(message: string): void;
  persistCheckpoint(checkpoint: TurnCheckpoint): Promise<void>;
  pauseForUser(reason: string): void;
  noteDispatched(): void;
}

export interface TurnRunShellHost {
  /** Prepared real Agent path; inactive until the single atomic flip. */
  readonly inactiveTurnAgentStreamPath?: InactiveTurnAgentStreamPath;
  readonly activateTurnAgentStream?: boolean;
  readonly isSubagentRunner: boolean;
  readonly subagentType?: string;
  readonly inheritedRequestSource?: string;
  readonly inheritedAutomationId?: string;
  readonly subagents: {
    readonly sessions: ReadonlyMap<
      string,
      { interrupt(reason: string): void }
    >;
  };
  getConversationId(): string;
  runGeneration(): number;
  setActiveTurnRequestSource(source: string | undefined): void;
  setActiveTurnAutomationId?(automationId: string | undefined): void;
  beginAutoReviewUserMessageEpoch(): void;
  setActiveRunInterrupted(value: boolean): void;
  setAwaitingUserSelection(value: boolean): void;
  isAwaitingUserSelection(): boolean;
  emitRunLifecycle(event: {
    type: "started" | "ended";
    requestId: string;
  }): void;
  emitUpdate?(event: { type: string; requestId?: string }): void;
  conversationSizeGuard?(): Promise<void>;
  beginLocalToolPermissionTurn?(conversationId: string): void;
  resolvePrivacyMode?(): Promise<unknown>;
  createInferenceSession?(context: TurnRunContext): Promise<TurnSession>;
  ensureBoxReady?(context: TurnRunContext): Promise<unknown>;
  discoverMcpTools?(context: TurnRunContext): Promise<readonly unknown[]>;
  refreshMcpAccountConfig?(): void;
  resolveMcpCustomInstructions?(): Promise<unknown>;
  setMcpDiscoveryUnavailableForTurn?(value: boolean): void;
  setMcpConnectedServerNamesForTurn?(names: readonly string[]): void;
  setMcpCustomInstructionsForTurn?(instructions: unknown): void;
  noteMcpToolDiscoveryFailed?(error: unknown): void;
  traceSendPhase?<T>(
    context: TurnRunContext,
    name: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  setTurnTraceAttributes?(attributes: Readonly<Record<string, string>>): void;
  resolveAutomationId?(wakeId: string): string;
  prepareTurn(
    prompt: string,
    options: TurnRunOptions,
    context: TurnRunContext,
  ): Promise<PreparedTurn>;
  runPreparedTurn(
    prepared: PreparedTurn,
    context: TurnRunContext,
    callbacks: TurnStreamCallbacks,
  ): Promise<TurnCheckpoint>;
  createSettleHost(): TurnSettleHost;
  profilePromptSnapshots(): unknown;
  memoryStore?(): Parameters<typeof createTurnSettle>[1]["memoryStore"];
  episodeProgress?(): Parameters<typeof createTurnSettle>[1]["episodeProgress"];
  isMemorableExchange?: (prompt: string) => boolean;
  getLatestPromptMessages?(): readonly unknown[];
  ownsFinalState?(generation: number): boolean;
  onRunUnwind?(): void;
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly generation: number;
  readonly requestId: string;
  dispatched: boolean;
  recoveryShaped: boolean;
  awaitingUserSelection: boolean;
  quiescedForUpgrade: boolean;
}

export function createTurnRunShell(host: TurnRunShellHost) {
  let quiescingForUpgrade = false;
  let activeRun: ActiveRun | null = null;

  function cancelRun(run: ActiveRun, cancellation: TurnCancellation): void {
    if (!run.controller.signal.aborted) {
      run.controller.abort(cancellation);
    }
  }

  function interrupt(
    reason: string,
    supersede?: { readonly carriesRecovery: boolean },
  ): boolean {
    const run = activeRun;
    if (run == null) return false;
    if (
      !run.dispatched
      && supersede != null
      && (!supersede.carriesRecovery || !run.recoveryShaped)
    ) {
      return false;
    }
    host.setActiveRunInterrupted(true);
    cancelRun(run, { intentional: true, reason });
    return true;
  }

  function requestQuiesceForUpgrade(): void {
    quiescingForUpgrade = true;
  }

  function isQuiescingForUpgrade(): boolean {
    return quiescingForUpgrade;
  }

  function cancelQuiesceForUpgrade(): void {
    quiescingForUpgrade = false;
  }

  function endTurnAwaitingUser(
    reason: string,
    owner: ActiveRun | null = activeRun,
  ): void {
    if (owner == null) return;
    owner.awaitingUserSelection = true;
    if (owner === activeRun) {
      host.setAwaitingUserSelection(true);
      cancelRun(owner, { intentional: true, reason });
      return;
    }
    cancelRun(owner, {
      intentional: true,
      reason: "awaiting user selection (escaped run)",
    });
  }

  function interruptAll(reason: string): boolean {
    const interrupted = interrupt(reason);
    for (const subagent of host.subagents.sessions.values()) {
      subagent.interrupt(reason);
    }
    return interrupted;
  }

  async function run(
    prompt: string,
    options: TurnRunOptions = {},
  ): Promise<TurnSettleResult> {
    const requestSource =
      options.requestSource ?? host.inheritedRequestSource;
    host.setActiveTurnRequestSource(requestSource);
    const turnAutomationId = options.automationWake == null
      ? host.inheritedAutomationId
      : host.resolveAutomationId?.(options.automationWake.id)
        ?? options.automationWake.id;
    host.setActiveTurnAutomationId?.(turnAutomationId);

    if (
      !host.isSubagentRunner
      && options.autoReviewEpoch !== "continue"
    ) {
      host.beginAutoReviewUserMessageEpoch();
    }

    const trimmedPrompt = prompt.trim();
    const selectedImages = options.selectedImages ?? [];
    const attachedFilePaths = options.attachedFilePaths ?? [];
    const selectedVideos = options.selectedVideos ?? [];
    if (
      trimmedPrompt.length === 0
      && selectedImages.length === 0
      && attachedFilePaths.length === 0
      && selectedVideos.length === 0
    ) {
      throw new SandEmptyPromptError();
    }

    const requestId = options.inferenceRequestId ?? randomUUID();
    const generation = host.runGeneration();
    const controller = new AbortController();
    const rawTranscriptText = options.messageId == null
      ? undefined
      : options.recentUserMessages?.find(
        (message) => message.id === options.messageId,
      )?.text;
    const runState: ActiveRun = {
      controller,
      generation,
      requestId,
      dispatched: false,
      recoveryShaped:
        options.messageId != null
        && selectedImages.length === 0
        && attachedFilePaths.length === 0
        && selectedVideos.length === 0
        && options.replyContext == null
        && rawTranscriptText != null
        && rawTranscriptText === trimmedPrompt,
      awaitingUserSelection: false,
      quiescedForUpgrade: false,
    };
    activeRun = runState;
    host.setActiveRunInterrupted(false);
    host.setAwaitingUserSelection(false);

    let lifecycleEnded = false;
    const endLifecycle = (): void => {
      if (lifecycleEnded) return;
      lifecycleEnded = true;
      host.emitRunLifecycle({ type: "ended", requestId });
    };
    host.emitRunLifecycle({ type: "started", requestId });
    const traceAttributes = {
      ...(options.automationWake == null
        ? {}
        : { "sand.automation_id": options.automationWake.id }),
      ...(!host.isSubagentRunner || host.subagentType == null
        ? {}
        : { "sand.subagent_type": host.subagentType }),
    };
    if (Object.keys(traceAttributes).length > 0) {
      host.setTurnTraceAttributes?.(traceAttributes);
    }

    const memoryStore = host.memoryStore?.();
    const episodeProgress = host.episodeProgress?.();
    const settle = createTurnSettle(
      host.createSettleHost(),
      {
        conversationId: host.getConversationId(),
        profilePromptSnapshots: host.profilePromptSnapshots(),
        ...(memoryStore == null ? {} : { memoryStore }),
        ...(episodeProgress === undefined
          ? {}
          : { episodeProgress }),
        ...(host.isMemorableExchange == null
          ? {}
          : { isMemorableExchange: host.isMemorableExchange }),
      },
    );

    let prepared: PreparedTurn | undefined;
    let finalState: TurnCheckpoint | undefined;
    let aborted = false;
    const turnStartedAtMs = Date.now();

    let context: TurnRunContext = {
      signal: controller.signal,
      requestId,
      generation,
    };

    try {
      if (!host.isSubagentRunner) {
        await host.conversationSizeGuard?.();
        if (options.autoReviewEpoch !== "continue") {
          host.beginLocalToolPermissionTurn?.(host.getConversationId());
        }
      }
      if (host.resolvePrivacyMode != null) {
        context = {
          ...context,
          privacyMode: await host.resolvePrivacyMode(),
        };
      }
      if (controller.signal.aborted) {
        throw new SandTurnInterruptedBeforeDispatchError();
      }

      if (host.createInferenceSession != null) {
        const create = () => host.createInferenceSession!(context);
        const inferenceSession = host.traceSendPhase == null
          ? await create()
          : await host.traceSendPhase(
            context,
            "inference.createSession",
            create,
          );
        context = { ...context, inferenceSession };
      }

      host.setMcpDiscoveryUnavailableForTurn?.(false);
      if (host.discoverMcpTools != null) {
        try {
          const mcpTools = await host.discoverMcpTools(context);
          context = { ...context, mcpTools };
          host.setMcpConnectedServerNamesForTurn?.(
            mcpTools.flatMap((tool) => {
              if (
                typeof tool !== "object"
                || tool == null
                || !("providerIdentifier" in tool)
                || typeof tool.providerIdentifier !== "string"
              ) return [];
              return [tool.providerIdentifier];
            }),
          );
        } catch (error) {
          host.noteMcpToolDiscoveryFailed?.(error);
        }
        host.refreshMcpAccountConfig?.();
      }
      if (host.resolveMcpCustomInstructions != null) {
        host.setMcpCustomInstructionsForTurn?.(
          await host.resolveMcpCustomInstructions(),
        );
      }

      prepared = await host.prepareTurn(
        trimmedPrompt,
        options,
        context,
      );
      settle.noteBaseState(
        prepared.baseState,
        prepared.transcriptPersistenceEnabled,
      );

      if (controller.signal.aborted) {
        throw new SandTurnInterruptedBeforeDispatchError();
      }

      if (host.ensureBoxReady != null) {
        const ensure = () => host.ensureBoxReady!(context);
        const boxConnection = host.traceSendPhase == null
          ? await ensure()
          : await host.traceSendPhase(context, "box.ensureReady", ensure);
        context = { ...context, boxConnection };
      }

      const callbacks: TurnStreamCallbacks = {
        ...settle.collectors,
        async persistCheckpoint(checkpoint): Promise<void> {
          if (host.runGeneration() !== generation) return;
          settle.prepareCheckpointForPersistence(checkpoint);
          await settle.persistStepCheckpoint(context, checkpoint);
          if (runState.awaitingUserSelection) {
            cancelRun(runState, {
              intentional: true,
              reason: "awaiting user selection",
            });
          } else if (quiescingForUpgrade) {
            runState.quiescedForUpgrade = true;
            cancelRun(runState, {
              intentional: true,
              reason: "quiescing for forced host upgrade",
            });
          }
        },
        pauseForUser(reason): void {
          endTurnAwaitingUser(reason, runState);
        },
        noteDispatched(): void {
          runState.dispatched = true;
        },
      };

      finalState = await host.runPreparedTurn(
        prepared,
        context,
        callbacks,
      );
      runState.dispatched = true;
      aborted =
        controller.signal.aborted
        && !runState.awaitingUserSelection
        && !runState.quiescedForUpgrade;
      endLifecycle();

      if (!aborted && !runState.quiescedForUpgrade) {
        await settle.settleCompletedTurn({
          finalState,
          turnStartedAtMs,
          hidden: options.hidden === true,
          trimmedPrompt,
          session: prepared.session,
          baseContext: context,
          requestId,
        });
      }
    } catch (error) {
      endLifecycle();
      if (!controller.signal.aborted) throw error;
      aborted =
        !runState.awaitingUserSelection
        && !runState.quiescedForUpgrade;
    } finally {
      const ownsRunner = activeRun === runState;
      if (ownsRunner) {
        activeRun = null;
        host.setActiveRunInterrupted(false);
        host.setActiveTurnAutomationId?.(undefined);
        host.onRunUnwind?.();
      }

      if (
        ownsRunner
        && finalState != null
        && host.runGeneration() === generation
        && (host.ownsFinalState?.(generation) ?? true)
      ) {
        await settle.persistFinalState(context, finalState);
      }
      endLifecycle();
    }

    return settle.buildResult({
      aborted,
      ...(runState.quiescedForUpgrade
        ? { quiescedForUpgrade: true }
        : {}),
      ...(runState.awaitingUserSelection
        || host.isAwaitingUserSelection()
        ? { awaitingUserSelection: true }
        : {}),
    });
  }

  return {
    run,
    inactiveTurnAgentStreamPath: host.inactiveTurnAgentStreamPath,
    isTurnAgentStreamActivationReady: () =>
      host.activateTurnAgentStream === true
      && host.inactiveTurnAgentStreamPath !== undefined,
    runInactiveTurnAgentStream: async (
      input: InactiveTurnAgentStreamStartInput,
    ) => {
      if (
        host.activateTurnAgentStream !== true
        || host.inactiveTurnAgentStreamPath === undefined
      ) throw new Error("turn Agent stream path is inactive");
      return host.inactiveTurnAgentStreamPath.startStream(input);
    },
    runInactiveTurnAgentLifecycle: (
      input: InactiveTurnAgentStreamLifecycleInput,
      context: Context,
    ) => {
      if (
        host.activateTurnAgentStream !== true
        || host.inactiveTurnAgentStreamPath === undefined
      ) throw new Error("turn Agent stream path is inactive");
      return host.inactiveTurnAgentStreamPath.createLifecycle(input).run(context);
    },
    interrupt,
    interruptAll,
    requestQuiesceForUpgrade,
    isQuiescingForUpgrade,
    cancelQuiesceForUpgrade,
    endTurnAwaitingUser,
    hasActiveRun: (): boolean => activeRun != null,
    activeRequestId: (): string | undefined => activeRun?.requestId,
  };
}
