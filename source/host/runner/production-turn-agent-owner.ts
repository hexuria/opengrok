import type { Context } from "../../packages/context/core.js";
import type { BlobStore } from "../../packages/agent-kv/blob-store.js";
import {
  ConversationStateStructure,
} from "../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  buildAgentForRun,
  createTurnLocalResourceProjection,
  type BuiltTurnAgentForRun,
  type TurnAgentBuildForRunInput,
  type TurnAgentResourceAccessor,
  type TurnAgentScope,
  type TurnAgentStaticConfigInputs,
  type TurnLocalResourceProjectionInput,
} from "./turn-agent-composition.js";
import type {
  TurnToolsetHost,
  TurnToolsetTurnInput,
} from "./tools/turn-toolset.js";
import {
  createProductionTurnToolsetHost,
  type ProductionTurnLazyToolsetHostInput,
  type ProductionTurnToolsetHostInput,
} from "../runner-production-bridge.js";
import type { SummarizationPromptSession } from "../../packages/agent-summarization/summarization-handler.js";
import type { DiskPressureReminderEpisodes } from "../extensions/forever-box/disk-pressure.js";
import type { AgentProfilePromptSnapshot } from "./sand-agent-profile-prompt.js";
import type { PromptSnapshotStore } from "./system-prompt-assembly.js";
import type { ForwardedUpdate } from "./agent-adapters.js";
import type { MessageLike } from "./send-message-reminder-middleware.js";
import {
  createTurnAgentRunInputProjection,
  type TurnAgentMcpTurnProvider,
} from "./turn-agent-composition.js";
import type {
  GeneratedTurnActionAssembly,
  GeneratedTurnPromptOptions,
} from "./prompt-collector-glue.js";
import {
  createTurnAgentRunContext,
  type TurnAgentInferenceOwner,
  type TurnAgentRunContext,
} from "./turn-run-shell.js";

/**
 * The host-owned inputs immediately before immutable buildAgentForRun.  This
 * is deliberately a concrete owner rather than a generic option bag: one
 * invocation creates one context/session pair, one resource accessor, and
 * one Agent.  The caller retains ownership of the Agent stream lifecycle.
 */
export interface ProductionTurnAgentOwnerInput {
  readonly context: Context;
  readonly conversationId: string;
  readonly requestId: string;
  readonly inference: TurnAgentInferenceOwner;
  readonly onRequestId: (requestId: string) => void;
  readonly isSubagentRunner: boolean;
  readonly isSilenceAllowed: boolean;
  readonly canUseSelfSummary: () => boolean;
  readonly cancelThisRun: TurnAgentScope["cancelThisRun"];
  readonly createResourceAccessor: (context: Context) => Promise<TurnAgentResourceAccessor>;
  readonly createRemoteBoxResourceAccessor: (context: Context) => Promise<TurnAgentResourceAccessor>;
  readonly createTurnLocalResourceProjectionInput: (
    baseAccessor: TurnAgentResourceAccessor,
  ) => Omit<TurnLocalResourceProjectionInput, "baseAccessor">;
  readonly blobStore: BlobStore<unknown>;
  /** Optional when the inference owner exposes its exact session factory. */
  readonly summarizationSession?: SummarizationPromptSession;
  readonly toolHost?: TurnToolsetHost;
  readonly toolsetHostInput?:
    | ProductionTurnToolsetHostInput
    | ProductionTurnLazyToolsetHostInput;
  readonly turn: TurnToolsetTurnInput;
  readonly staticConfig: Omit<TurnAgentStaticConfigInputs, "toolsGenerator">;
  readonly emitUpdate: (update: ForwardedUpdate) => void;
  readonly interactionObservers: ConstructorParameters<
    typeof import("./agent-adapters.js").ForwardingInteractionListener
  >[1];
  readonly diskPressureReminder?: DiskPressureReminderEpisodes;
  readonly diskPressureClaimId?: string;
  readonly ackToken?: string;
  readonly pauseThisRun?: () => void;
  readonly isRunAwaitingUserSelection?: () => boolean;
  readonly endThisRunAwaitingUser?: (reason: string) => void;
  readonly requestSource?: string;
  readonly modelId?: string;
  readonly hidden?: boolean;
  readonly lineage?: unknown;
  readonly profilePromptSnapshot?: AgentProfilePromptSnapshot;
  readonly profilePromptSnapshotStore?: PromptSnapshotStore;
  readonly onProfileUpdateAppended?: (identity: {
    readonly name: string;
    readonly description: string;
  }) => void;
  readonly emittedConnectorCards: Set<string>;
  readonly diskPressureReminderEpisodeId?: string | null;
  readonly onLatestPromptMessages?: (getter: () => readonly MessageLike[]) => void;
}

export interface ProductionTurnAgentOwner {
  readonly built: BuiltTurnAgentForRun;
  readonly runContext: TurnAgentRunContext<Context>;
  readonly buildInput: TurnAgentBuildForRunInput;
  dispose(): void;
}

/** Exact per-run caller input immediately before the stream projection. */
export interface ProductionTurnAgentRunInput {
  readonly runCtx: Context;
  readonly trimmedPrompt: string;
  readonly promptOptions: GeneratedTurnPromptOptions;
  readonly assembleGeneratedTurnAction: (input: {
    readonly runCtx: Context;
    readonly trimmedPrompt: string;
    readonly options: GeneratedTurnPromptOptions;
    readonly profileUpdateForTurn?: { readonly text: string };
    readonly compactionEpoch: () => number;
  }) => Promise<GeneratedTurnActionAssembly>;
  readonly profileUpdateForTurn?: { readonly text: string };
  readonly compactionEpoch: () => number;
  readonly getConversationState: () => ConversationStateStructure;
  readonly mcp?: TurnAgentMcpTurnProvider;
  readonly onMcpDiscoveryFailed?: (error: unknown) => void;
}

export async function createProductionTurnAgentRunInput(
  input: ProductionTurnAgentRunInput,
) {
  const assembly = await input.assembleGeneratedTurnAction({
    runCtx: input.runCtx,
    trimmedPrompt: input.trimmedPrompt,
    options: input.promptOptions,
    ...(input.profileUpdateForTurn === undefined
      ? {}
      : { profileUpdateForTurn: input.profileUpdateForTurn }),
    compactionEpoch: input.compactionEpoch,
  });
  return createTurnAgentRunInputProjection({
    runCtx: input.runCtx,
    createAction: async () => assembly.action,
    ...(input.mcp === undefined ? {} : { mcp: input.mcp }),
    ...(input.onMcpDiscoveryFailed === undefined
      ? {}
      : { onMcpDiscoveryFailed: input.onMcpDiscoveryFailed }),
    getConversationState: input.getConversationState,
  });
}

/**
 * Creates the exact per-turn constructor input consumed by buildAgentForRun.
 * Privacy/session creation and resource readiness precede construction; the
 * returned disposer releases an uncommitted disk-pressure claim exactly once.
 */
export async function createProductionTurnAgentOwner(
  input: ProductionTurnAgentOwnerInput,
): Promise<ProductionTurnAgentOwner> {
  const runContext = await createTurnAgentRunContext({
    context: input.context,
    conversationId: input.conversationId,
    requestId: input.requestId,
    inference: input.inference,
    onRequestId: input.onRequestId,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.requestSource === undefined
      ? {}
      : { requestSource: input.requestSource }),
    isSubagentRunner: input.isSubagentRunner,
    isSilenceAllowed: input.isSilenceAllowed,
    ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
    ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
    canUseSelfSummary: input.canUseSelfSummary,
    ...(input.diskPressureReminder === undefined
      ? {}
      : { diskPressureReminder: input.diskPressureReminder }),
    ...(input.diskPressureClaimId === undefined
      ? {}
      : { diskPressureClaimId: input.diskPressureClaimId }),
    cancelThisRun: input.cancelThisRun,
    ...(input.ackToken === undefined ? {} : { ackToken: input.ackToken }),
    ...(input.pauseThisRun === undefined ? {} : { pauseThisRun: input.pauseThisRun }),
    ...(input.isRunAwaitingUserSelection === undefined
      ? {}
      : { isRunAwaitingUserSelection: input.isRunAwaitingUserSelection }),
    ...(input.endThisRunAwaitingUser === undefined
      ? {}
      : { endThisRunAwaitingUser: input.endThisRunAwaitingUser }),
    ...(input.profilePromptSnapshot === undefined
      ? {}
      : { profilePromptSnapshot: input.profilePromptSnapshot }),
    ...(input.profilePromptSnapshotStore === undefined
      ? {}
      : { profilePromptSnapshotStore: input.profilePromptSnapshotStore }),
    ...(input.onProfileUpdateAppended === undefined
      ? {}
      : { onProfileUpdateAppended: input.onProfileUpdateAppended }),
    emittedConnectorCards: input.emittedConnectorCards,
    ...(input.diskPressureReminderEpisodeId === undefined
      ? {}
      : { diskPressureReminderEpisodeId: input.diskPressureReminderEpisodeId }),
    ...(input.onLatestPromptMessages === undefined
      ? {}
      : { onLatestPromptMessages: input.onLatestPromptMessages }),
  });

  try {
    const baseResourceAccessor = await input.createResourceAccessor(input.context);
    const remoteBoxResourceAccessor = await input.createRemoteBoxResourceAccessor(input.context);
    const turnLocalResourceProjection = createTurnLocalResourceProjection({
      ...input.createTurnLocalResourceProjectionInput(baseResourceAccessor),
      baseAccessor: baseResourceAccessor,
    });
    const resourceAccessor = turnLocalResourceProjection.resourceAccessor;
    const turn: TurnToolsetTurnInput = {
      ...input.turn,
      remoteBoxResourceAccessor,
      toolSession: runContext.toolSession,
    };
    const summarizationSession = input.summarizationSession
      ?? runContext.summarizationSession;
    if (summarizationSession === undefined) {
      throw new TypeError("production Agent summarization session is not bound");
    }
    const toolHost = input.toolHost
      ?? (input.toolsetHostInput === undefined
        ? undefined
        : createProductionTurnToolsetHost(input.toolsetHostInput));
    if (toolHost === undefined) {
      throw new TypeError("production Agent TurnToolsetHost is not bound");
    }
    const buildInput: TurnAgentBuildForRunInput = {
      staticConfig: input.staticConfig,
      toolSession: runContext.toolSession,
      emitUpdate: input.emitUpdate,
      interactionObservers: input.interactionObservers,
      privacyMode: runContext.privacyMode,
      resourceAccessor,
      blobStore: input.blobStore,
      summarizationSession,
      toolHost,
      turn,
      turnScope: runContext.scope,
    };
    return {
      built: buildAgentForRun(buildInput),
      runContext,
      buildInput,
      dispose: () => runContext.dispose(),
    };
  } catch (error) {
    runContext.dispose();
    throw error;
  }
}

/** Keeps the generated state clone boundary explicit for host callers. */
export function cloneProductionTurnState(
  state: ConversationStateStructure,
): ConversationStateStructure {
  return ConversationStateStructure.fromBinary(state.toBinary());
}
