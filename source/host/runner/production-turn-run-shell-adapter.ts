import type { Context } from "../../packages/context/core.js";
import type {
  ConversationStateStructure as ConversationStateStructureMessage,
} from "../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  createProductionTurnAgentOwner,
  createProductionTurnAgentRunInput,
  type ProductionTurnAgentOwner,
  type ProductionTurnAgentOwnerInput,
  type ProductionTurnAgentRunInput,
} from "./production-turn-agent-owner.js";
import { createTurnAgentStreamStart } from "./turn-agent-composition.js";
import {
  createTurnRunShell,
  type PreparedTurn,
  type TurnRunContext,
  type TurnRunOptions,
  type TurnRunShellHost,
  type TurnStreamCallbacks,
} from "./turn-run-shell.js";
import type {
  TurnCheckpoint,
  TurnSession,
  TurnSettleHost,
} from "./turn-settle.js";
import type {
  GeneratedTurnPromptOptions,
} from "./prompt-collector-glue.js";
import type { TurnAgentMcpTurnProvider } from "./turn-agent-composition.js";
import type { ForwardedUpdate } from "./agent-adapters.js";

export interface ProductionTurnRunShellPreparedTurn extends PreparedTurn {
  readonly baseState: ConversationStateStructureMessage;
  readonly productionOwner: ProductionTurnAgentOwner;
  readonly productionInput: Awaited<
    ReturnType<typeof createProductionTurnAgentRunInput>
  >;
  readonly runContext: Context;
  readonly disposeRunContext: () => void;
  readonly updateRelay: {
    callbacks?: TurnStreamCallbacks;
    prepared?: ProductionTurnRunShellPreparedTurn;
  };
}

function linkTurnRunContext(
  base: Context,
  signal: AbortSignal,
): { readonly context: Context; readonly dispose: () => void } {
  const [context, cancel] = base.withCancel();
  const abort = () => cancel(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return {
    context,
    dispose: () => signal.removeEventListener("abort", abort),
  };
}

/** Exact host inputs around the existing turn-run-shell lifecycle. */
export interface ProductionTurnRunShellAdapterInput {
  readonly createOwner: (input: {
    readonly requestId: string;
    readonly runOptions: TurnRunOptions;
    readonly context: Context;
    readonly cancelThisRun: ProductionTurnAgentOwner["runContext"]["scope"]["cancelThisRun"];
    readonly emitUpdate: (update: ForwardedUpdate) => void;
  }) => Promise<ProductionTurnAgentOwner>;
  readonly createRunInput: (input: {
    readonly owner: ProductionTurnAgentOwner;
    readonly runContext: Context;
    readonly prompt: string;
    readonly options: GeneratedTurnPromptOptions;
  }) => Promise<Awaited<ReturnType<typeof createProductionTurnAgentRunInput>>>;
  readonly promptOptions: (
    prompt: string,
    options: TurnRunOptions,
  ) => GeneratedTurnPromptOptions;
  readonly createSession: (owner: ProductionTurnAgentOwner) => TurnSession;
  readonly context: () => Context;
  readonly createSettleHost: () => TurnSettleHost;
  readonly profilePromptSnapshots: () => unknown;
  readonly isSubagentRunner: boolean;
  readonly subagentType?: string;
  readonly inheritedRequestSource?: string;
  readonly inheritedAutomationId?: string;
  readonly subagents: TurnRunShellHost["subagents"];
  readonly getConversationId: () => string;
  readonly runGeneration: () => number;
  readonly setActiveTurnRequestSource: (source: string | undefined) => void;
  readonly setActiveTurnAutomationId?: (automationId: string | undefined) => void;
  readonly beginAutoReviewUserMessageEpoch: () => void;
  readonly setActiveRunInterrupted: (value: boolean) => void;
  readonly setAwaitingUserSelection: (value: boolean) => void;
  readonly isAwaitingUserSelection: () => boolean;
  readonly emitRunLifecycle: TurnRunShellHost["emitRunLifecycle"];
  readonly emitUpdate: (update: ForwardedUpdate) => void;
  readonly lastReactionApplied?: () => boolean;
  readonly cancelThisRun: ProductionTurnAgentOwner["runContext"]["scope"]["cancelThisRun"];
  readonly onRunUnwind?: () => void;
}

/**
 * Concrete turn-side inputs for the production shell lifecycle.
 *
 * This is intentionally expressed in terms of the real owner inputs rather
 * than a preassembled adapter object: one call creates the Agent owner, and
 * one prepared turn creates the generated action/MCP/state projection. The
 * host remains responsible only for supplying its live service identities
 * and lifecycle callbacks.
 */
export interface ProductionTurnRunShellHostInput extends Omit<
  ProductionTurnRunShellAdapterInput,
  "createOwner" | "createRunInput" | "promptOptions"
> {
  readonly createAgentOwnerInput: (input: {
    readonly requestId: string;
    readonly runOptions: TurnRunOptions;
    readonly context: Context;
    readonly cancelThisRun: ProductionTurnAgentOwnerInput["cancelThisRun"];
    readonly emitUpdate: ProductionTurnAgentOwnerInput["emitUpdate"];
  }) => ProductionTurnAgentOwnerInput;
  readonly promptOptions: (
    prompt: string,
    options: TurnRunOptions,
  ) => GeneratedTurnPromptOptions;
  readonly assembleGeneratedTurnAction: ProductionTurnAgentRunInput["assembleGeneratedTurnAction"];
  readonly compactionEpoch: ProductionTurnAgentRunInput["compactionEpoch"];
  readonly getConversationState: ProductionTurnAgentRunInput["getConversationState"];
  readonly mcp?: TurnAgentMcpTurnProvider;
  readonly onMcpDiscoveryFailed?: ProductionTurnAgentRunInput["onMcpDiscoveryFailed"];
}

/**
 * Joins the real prompt/action/state/session owners to the existing shell
 * lifecycle. No adapter callbacks are accepted from the caller: this owner
 * constructs them from the concrete Agent owner and generated turn producer.
 */
export function createProductionTurnRunShellHostInput(
  input: ProductionTurnRunShellHostInput,
): ProductionTurnRunShellAdapterInput {
  const {
    createAgentOwnerInput,
    assembleGeneratedTurnAction,
    compactionEpoch,
    getConversationState,
    mcp,
    onMcpDiscoveryFailed,
    promptOptions,
    ...lifecycle
  } = input;
  return {
    ...lifecycle,
    promptOptions,
    createOwner: async ({
      requestId,
      runOptions,
      context,
      cancelThisRun,
      emitUpdate,
    }) => createProductionTurnAgentOwner({
      ...createAgentOwnerInput({
        requestId,
        runOptions,
        context,
        cancelThisRun,
        emitUpdate,
      }),
      context,
      requestId,
      cancelThisRun,
      emitUpdate,
    }),
    createRunInput: async ({ owner, runContext, prompt, options }) =>
      createProductionTurnAgentRunInput({
        runCtx: runContext,
        trimmedPrompt: prompt.trim(),
        promptOptions: options,
        assembleGeneratedTurnAction,
        ...(owner.runContext.profileUpdateForTurn === undefined
          ? {}
          : { profileUpdateForTurn: owner.runContext.profileUpdateForTurn }),
        compactionEpoch,
        getConversationState,
        ...(mcp === undefined ? {} : { mcp }),
        ...(onMcpDiscoveryFailed === undefined
          ? {}
          : { onMcpDiscoveryFailed }),
      }),
  };
}

function cloneBaseTurnCheckpoint(
  state: ConversationStateStructureMessage,
): ConversationStateStructureMessage {
  return state.clone();
}

/**
 * Binds the recovered Agent owner to turn-run-shell. Retry, accepted
 * checkpoint capture, generation gates, quiesce, final settle, and cleanup
 * remain owned by the existing lifecycle; this module only supplies its
 * three missing host methods.
 */
export function createProductionTurnRunShellAdapter(
  input: ProductionTurnRunShellAdapterInput,
) {
  const prepared = new WeakMap<object, ProductionTurnRunShellPreparedTurn>();
  let activeOwner: ProductionTurnAgentOwner | undefined;
  let activePrepared: ProductionTurnRunShellPreparedTurn | undefined;
  const host: TurnRunShellHost = {
    isSubagentRunner: input.isSubagentRunner,
    ...(input.subagentType === undefined ? {} : { subagentType: input.subagentType }),
    ...(input.inheritedRequestSource === undefined
      ? {}
      : { inheritedRequestSource: input.inheritedRequestSource }),
    ...(input.inheritedAutomationId === undefined
      ? {}
      : { inheritedAutomationId: input.inheritedAutomationId }),
    subagents: input.subagents,
    getConversationId: input.getConversationId,
    runGeneration: input.runGeneration,
    setActiveTurnRequestSource: input.setActiveTurnRequestSource,
    ...(input.setActiveTurnAutomationId === undefined
      ? {}
      : { setActiveTurnAutomationId: input.setActiveTurnAutomationId }),
    beginAutoReviewUserMessageEpoch: input.beginAutoReviewUserMessageEpoch,
    setActiveRunInterrupted: input.setActiveRunInterrupted,
    setAwaitingUserSelection: input.setAwaitingUserSelection,
    isAwaitingUserSelection: input.isAwaitingUserSelection,
    emitRunLifecycle: input.emitRunLifecycle,
    async prepareTurn(
      prompt: string,
      options: TurnRunOptions,
      context: TurnRunContext,
    ): Promise<PreparedTurn> {
      const linked = linkTurnRunContext(input.context(), context.signal);
      const updateRelay: ProductionTurnRunShellPreparedTurn["updateRelay"] = {};
      const emitUpdate = (update: ForwardedUpdate): void => {
        const callbacks = activePrepared === updateRelay.prepared
          ? updateRelay.callbacks
          : undefined;
        if (callbacks !== undefined) {
          if (update.type === "text-delta" && typeof update.text === "string") {
            callbacks.collectText(update.text);
          } else if (update.type === "send-message") {
            callbacks.collectSendMessage();
            const message = update.message;
            if (
              typeof message === "object"
              && message != null
              && Reflect.get(message, "type") === "text"
              && typeof Reflect.get(message, "content") === "string"
            ) {
              callbacks.collectAgentMessage(Reflect.get(message, "content"));
            }
          }
        }
        input.emitUpdate(update);
        if (
          callbacks !== undefined
          && update.type === "react-to-message"
          && input.lastReactionApplied?.() === true
        ) {
          callbacks.collectReaction();
        }
      };
      try {
        const owner = await input.createOwner({
          requestId: context.requestId,
          runOptions: options,
          context: linked.context,
          cancelThisRun: input.cancelThisRun,
          emitUpdate,
        });
        const productionInput = await input.createRunInput({
          owner,
          runContext: linked.context,
          prompt,
          options: input.promptOptions(prompt, options),
        });
        const result: ProductionTurnRunShellPreparedTurn = {
          action: productionInput.action,
          baseState: cloneBaseTurnCheckpoint(productionInput.baseState),
          transcriptPersistenceEnabled: true,
          session: input.createSession(owner),
          productionOwner: owner,
          productionInput,
          runContext: linked.context,
          disposeRunContext: linked.dispose,
          updateRelay,
        };
        updateRelay.prepared = result;
        activeOwner = owner;
        activePrepared = result;
        prepared.set(result, result);
        return result;
      } catch (error) {
        linked.dispose();
        throw error;
      }
    },
    async runPreparedTurn(
      preparedTurn: PreparedTurn,
      _context: TurnRunContext,
      callbacks: TurnStreamCallbacks,
    ): Promise<TurnCheckpoint> {
      const owned = prepared.get(preparedTurn);
      if (owned === undefined) {
        throw new TypeError("production turn prepared owner is not bound");
      }
      owned.updateRelay.callbacks = callbacks;
      const stream = createTurnAgentStreamStart({
        agent: owned.productionOwner.built,
        baseState: owned.baseState,
        action: owned.productionInput.action,
        privacyMode: owned.productionOwner.runContext.privacyMode,
        mcpTools: owned.productionInput.mcpTools,
      });
      const finalState = await stream.startStream(
        owned.runContext,
        undefined,
        async (
          _checkpointContext: Context,
          checkpoint: ConversationStateStructureMessage,
        ) => {
          await callbacks.persistCheckpoint(checkpoint);
        },
      );
      owned.productionOwner.runContext.commitDiskPressureReminder();
      return finalState;
    },
    createSettleHost: input.createSettleHost,
    profilePromptSnapshots: input.profilePromptSnapshots,
    onRunUnwind: () => {
      const owner = activeOwner;
      activeOwner = undefined;
      if (activePrepared !== undefined) {
        delete activePrepared.updateRelay.callbacks;
      }
      // The stream context is linked to the shell controller and must not
      // retain the outer run's abort listener after owner disposal.
      activePrepared?.disposeRunContext();
      activePrepared = undefined;
      owner?.dispose();
      input.onRunUnwind?.();
    },
  };
  return createTurnRunShell(host);
}
