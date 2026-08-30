import { randomUUID } from "node:crypto";
import type { Context } from "../../packages/context/core.js";
import { CONNECTOR_MANIFESTS, type ConnectorManifest } from "../../shared/channels.js";
import { InMemoryBlobStore } from "../../packages/agent-kv/blob-store.js";
import type { BlobStore } from "../../packages/agent-kv/blob-store.js";
import {
  createBackgroundWatches,
  type BackgroundWatchesHost,
} from "./background-work.js";
import {
  createShellWatchGeneratedStateProjection,
  createShellWatchReadAccessor,
  pollShellTerminalFile,
  type ShellWatchResourceAccessor,
  type ShellTerminalWatchHost,
  type ConfirmedUserTurnWatermark,
} from "./shell-terminal-watch.js";
import {
  ConversationStateStructure,
  type ConversationStateStructure as ConversationStateStructureMessage,
} from "../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  createSubagentRuntime,
  type BackgroundSubagentCompletion,
  type RunningSubagentInfo,
  type SubagentRuntimeHost,
} from "./subagent-runtime.js";
import { createToolCallIdentity } from "./tool-call-identity.js";
import { createComputerUseCoordination } from "./computer-use.js";
import { createSandNavigationProbe } from "./sand-action-audit.js";
import type { TurnUsage } from "./turn-usage.js";
import {
  createTurnObservation,
  type AsyncTask,
} from "./turn-observation.js";
import {
  SAND_AGENT_MAX_STEPS,
} from "./turn-agent-composition.js";
import {
  createProductionTurnRunShellAdapter,
  type ProductionTurnRunShellAdapterInput,
} from "./production-turn-run-shell-adapter.js";
import type { ForwardedUpdate } from "./agent-adapters.js";
import type {
  InactiveTurnAgentStreamPath,
  InactiveTurnAgentStreamLifecycleInput,
  InactiveTurnAgentStreamStartInput,
} from "./inactive-turn-agent-stream.js";
import type {
  SandAutoReviewController,
  SandAutoReviewResolution,
} from "./sand-auto-review.js";
import {
  deriveOutlineFromConversationState,
  type ConversationState as OutlineConversationState,
  type OutlineItem,
} from "./conversation-outline.js";

export interface AgentBlobStoreOwner {
  getBlobStore(): BlobStore<unknown>;
}

export function getAgentBlobStore(owner: AgentBlobStoreOwner): BlobStore<unknown> {
  return owner.getBlobStore();
}

export interface AgentPromptSession {
  getModelId(): string;
  getExecutor(state?: unknown): unknown;
}

export interface AgentResourceAccessor {
  get(resource: unknown): unknown;
}

export interface AgentSummarizationHandler {
  getModelId(): string;
}

export interface AgentMediaDimensions {
  readonly width: number;
  readonly height: number;
}

export interface AgentProfileForRunner {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly settingsFilePath: string;
}

export interface AgentConversationActionReceiver {
  peek(context: unknown): Promise<unknown>;
  pop(context: unknown): Promise<undefined>;
}

interface RunnerShellWatchBox {
  ensureReady(
    context: Context,
    agentId: string,
  ): Promise<{
    readonly remoteAccessor: ShellWatchResourceAccessor<Context>;
    readonly terminalsFolder: string;
  }>;
}

type RunnerBackgroundWatches = ReturnType<typeof createBackgroundWatches>;

export const BOX_CDP_PORT_BASE = 9_222;

export interface RunnerConversationState
  extends OutlineConversationState {
  summaryArchives: readonly unknown[];
  turnTimings: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface RunnerTransport {
  onUpdate(update: RunnerUpdate | ForwardedUpdate): void;
  lastReactionApplied?(): boolean;
  lastSentMessageId?(): string | undefined;
}

export type RunnerUpdate =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "thinking-delta"; readonly text: string }
  | {
    readonly type: "tool-call";
    readonly id: string;
    readonly name?: string;
    readonly status?: string;
    readonly summary?: string;
    readonly args?: string;
  }
  | {
    readonly type: "send-message";
    readonly message: Readonly<Record<string, unknown>> & {
      readonly type: string;
    };
    readonly timestampMs: number;
  }
  | { readonly type: "turn-ended"; readonly usage?: unknown }
  | { readonly type: "react-to-message"; readonly messageAddress: string; readonly emoji: string }
  | { readonly type: "request-id"; readonly requestId: string }
  | { readonly type: "retrying" };

export interface SandAgentRunnerResult {
  readonly text: string;
  readonly sentMessageCount: number;
  readonly reacted: boolean;
  readonly aborted: boolean;
  readonly quiescedForUpgrade?: boolean;
  readonly awaitingUserSelection?: boolean;
  readonly streamOutputProduced?: boolean;
}

export interface SandAgentRunnerOptions<T = unknown> {
  /** Exact real Agent stream path, deliberately inactive pending factory closure. */
  readonly inactiveTurnAgentStreamPath?: InactiveTurnAgentStreamPath;
  readonly activateTurnAgentStream?: boolean;
  readonly conversationId?: string;
  readonly ctx?: Context;
  readonly box?: RunnerShellWatchBox;
  readonly cloudAgentWatcher?: NonNullable<ReturnType<BackgroundWatchesHost["cloudAgentWatcher"]>>;
  readonly transcriptId?: string;
  readonly boxId?: string;
  readonly initialState?: RunnerConversationState;
  readonly blobStore?: BlobStore<unknown>;
  readonly createPromptSession?: (
    onRequestId: (requestId: string) => void,
    options?: Readonly<Record<string, unknown>>,
  ) => AgentPromptSession;
  readonly createResourceAccessor?: (
    context: unknown,
  ) => Promise<AgentResourceAccessor>;
  readonly createSummarizationHandler?: (
    summarizationSession: unknown,
    options?: Readonly<{ preserveLatestImage?: boolean }>,
  ) => AgentSummarizationHandler;
  readonly createConversationActionReceiver?: () => AgentConversationActionReceiver;
  readonly transport?: RunnerTransport;
  readonly agentProfileProvider?: () => AgentProfileForRunner | null;
  readonly connectorManifests?: readonly ConnectorManifest[];
  readonly ingestAttachment?: (sourcePath: string) => Promise<string>;
  readonly persistImage?: (...args: unknown[]) => unknown;
  readonly persistMediaBytes?: (
    filename: string,
    data: Uint8Array,
  ) => Promise<string | null>;
  readonly readVideoAttachmentBytes?: (
    filePath: string,
  ) => Promise<Uint8Array | null>;
  readonly readMediaDimensions?: (
    filePath: string,
  ) => Promise<AgentMediaDimensions | null>;
  readonly isSubagent?: boolean;
  readonly isSharedRoomTurn?: boolean;
  readonly isSharedRoomBoxToolsEnabled?: () => boolean;
  readonly subagentType?: string;
  readonly subagentModelId?: string;
  readonly requestSource?: string;
  readonly automationId?: string;
  readonly autoReviewController?: SandAutoReviewController;
  readonly prepare?: () => Promise<void>;
  readonly runStep?: (
    step: number,
    context: {
      readonly signal: AbortSignal;
      readonly emitUpdate: (update: RunnerUpdate) => void;
      readonly prompt: string;
      readonly runOptions: Readonly<Record<string, unknown>>;
      readonly requestId: string;
      readonly state: RunnerConversationState;
      readonly setState: (state: RunnerConversationState) => void;
    },
  ) => Promise<{ readonly done: boolean; readonly value?: T }>;
  readonly settle?: (value: T | undefined) => Promise<void>;
  readonly maxSteps?: number;
  readonly getBoxId?: () => string;
  readonly getAgentId?: () => string;
  readonly workflowStore?: unknown;
  readonly channelStore?: unknown;
  readonly getTranscriptsFolder?: () => string | undefined;
  readonly getBoxTerminalsFolder?: () => string | undefined;
  readonly getBoxWindowIndex?: (boxId: string) => number | undefined;
  readonly isCloudAgentsDisabledByTeam?: () => boolean;
  readonly getPendingCloudAgentWatchBcIds?: () => readonly string[];
  readonly hasRunningBackgroundShellWork?: () => boolean;
  readonly cancelBackgroundShellRewatches?: () => void;
  readonly getPendingShellRewatchIds?: () => readonly string[];
  readonly getComputerUseUsageSnapshot?: () => {
    readonly modelId?: string;
    readonly turnEndedCount: number;
    readonly usage?: unknown;
  };
  readonly getComputerUseAuditActionCounts?: () => ReadonlyMap<string, number>;
  readonly onRunLifecycle?: (event: {
    readonly type: "started" | "ended";
    readonly requestId: string;
  }) => void;
  readonly onComputerUseUsage?: (event: unknown) => void;
  readonly onPendingWakeArmed?: (event: unknown) => void;
  readonly onPendingWakeDisarmed?: (event: unknown) => void;
  readonly actionAuditor?: { record(record: unknown): void };
  readonly freeComputerUseWindow?: (subagentAgentId: string) => void;
  readonly navigationProbe?: ReturnType<typeof createSandNavigationProbe<Context>>;
  readonly now?: () => number;
  /** Complete real turn-shell owner; absent keeps the legacy path fail-closed. */
  readonly productionTurnRunShell?: Pick<
    ProductionTurnRunShellAdapterInput,
    | "createOwner"
    | "createRunInput"
    | "promptOptions"
    | "createSession"
    | "context"
    | "createSettleHost"
    | "profilePromptSnapshots"
    | "cancelThisRun"
  >;
}

interface ActiveRun {
  readonly requestId: string;
  readonly controller: AbortController;
  readonly generation: number;
  dispatched: boolean;
  recoveryShaped: boolean;
  awaitingUserSelection: boolean;
  quiescedForUpgrade: boolean;
  text: string;
  sentMessageCount: number;
  reacted: boolean;
  streamOutputProduced: boolean;
}

function createEmptyState(): RunnerConversationState {
  return {
    turns: [],
    summaryArchives: [],
    turnTimings: [],
  };
}

export class SandAgentRunner<T = unknown> {
  #state: RunnerConversationState;
  #runGeneration = 0;
  #fallbackConversationId = `sand-${randomUUID()}`;
  #fallbackBlobStore = new InMemoryBlobStore();
  #blobStore: BlobStore<unknown>;
  #productionConversationStateStructure: ConversationStateStructureMessage | undefined;
  #activeRun: ActiveRun | null = null;
  #quiescingForUpgrade = false;
  #awaitingUserSelection = false;
  #activeRunInterrupted = false;
  #activeTurnRequestSource: string | undefined;
  #activeTurnAutomationId: string | undefined;
  #streamOutputProducedThisAttempt = false;
  #clearFirstTokenDeadline: (() => void) | undefined;
  #resetFirstTokenDeadline: (() => void) | undefined;
  #observeFirstToken: (() => void) | undefined;
  #latestPromptMessagesGetter: (() => readonly unknown[]) | undefined;
  #confirmedUserTurnWatermarkCache:
    | { readonly turnCount: number; readonly messageId: string }
    | undefined;
  #shellWatchWatermarkCache: ConfirmedUserTurnWatermark | undefined;
  #backgroundWatches: RunnerBackgroundWatches | undefined;
  #disposed = false;
  #productionTurnRunShell?: ReturnType<typeof createProductionTurnRunShellAdapter>;

  #agentStore: unknown;
  #agentProfileProvider: unknown;
  readonly connectorManifests: readonly ConnectorManifest[];
  #attachmentIngestor: unknown;
  #persistImage: unknown;
  #persistMediaBytes: unknown;
  #mcp: unknown;
  #mcpManagement: unknown;
  #memoryStore: unknown;
  #userMemory: unknown;
  #projectMemory: unknown;
  #memorySnapshots: unknown;
  #profilePromptSnapshots: unknown;
  #episodeProgress: unknown;
  #automationStore: unknown;
  #workflowStore: unknown;
  #channelStore: unknown;
  #boxTerminalsFolder: string | undefined;
  #computerUse: ReturnType<typeof createComputerUseCoordination<Context>> | undefined;

  #onComputerUseUsage: ((event: unknown) => void) | undefined;
  #onBackgroundShellSettled:
    | ((completion: BackgroundSubagentCompletion) => void)
    | undefined;
  #onPendingWakeArmed: ((event: unknown) => void) | undefined;
  #onPendingWakeDisarmed: ((event: unknown) => void) | undefined;

  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly isSharedRoomBoxToolsEnabled: (() => boolean) | undefined;
  readonly subagentType: string | undefined;
  readonly subagentModelId: string | undefined;
  readonly inheritedRequestSource: string | undefined;
  readonly inheritedAutomationId: string | undefined;
  readonly autoReviewController: SandAutoReviewController | undefined;
  readonly subagentTranscriptId: string | undefined;

  readonly observation;
  readonly subagents;
  readonly toolCallIdentity;

  constructor(readonly options: SandAgentRunnerOptions<T>) {
    this.#state = options.initialState ?? createEmptyState();
    this.#blobStore = options.blobStore ?? this.#fallbackBlobStore;
    this.isSubagentRunner = options.isSubagent ?? false;
    this.isSharedRoomRunner = options.isSharedRoomTurn ?? false;
    this.isSharedRoomBoxToolsEnabled = options.isSharedRoomBoxToolsEnabled;
    this.subagentType = options.subagentType;
    this.subagentModelId = options.subagentModelId;
    this.inheritedRequestSource = options.requestSource;
    this.inheritedAutomationId = options.automationId;
    this.autoReviewController = options.autoReviewController;
    this.subagentTranscriptId = options.transcriptId;
    this.#onComputerUseUsage = options.onComputerUseUsage;
    this.#onPendingWakeArmed = options.onPendingWakeArmed;
    this.#onPendingWakeDisarmed = options.onPendingWakeDisarmed;
    this.#agentProfileProvider = options.agentProfileProvider;
    this.connectorManifests = options.connectorManifests ?? CONNECTOR_MANIFESTS;
    this.#attachmentIngestor = options.ingestAttachment;
    this.#persistImage = options.persistImage;
    this.#persistMediaBytes = options.persistMediaBytes;
    this.#workflowStore = this.isSharedRoomRunner
      ? undefined
      : options.workflowStore;
    this.#channelStore = this.isSharedRoomRunner
      ? undefined
      : options.channelStore;

    this.observation = createTurnObservation({
      getConversationId: () => this.getConversationId(),
      isActiveRunCanceled: () => this.#activeRun?.controller.signal.aborted ?? false,
      isActiveRunInterrupted: () => this.#activeRunInterrupted,
      subagentRegistryEntries: () => this.subagents.registryEntries(),
      isSubagentAborting: id => this.subagents.isAborting(id),
      listBackgroundShellWork: () => this.#backgroundWatches?.listRegisteredShellWork({ kind: "shell" }) ?? [],
      shellRewatchEntries: () => this.#backgroundWatches?.shellRewatchEntries() ?? [],
      cloudAgentWatchEntries: () => this.#backgroundWatches?.cloudAgentWatchEntries() ?? [],
      ...(options.now == null ? {} : { now: options.now }),
      onEvent: () => {},
    });
    this.toolCallIdentity = createToolCallIdentity({
      emitUpdate: (update) =>
        this.emitUpdate({
          type: "tool-call",
          id: typeof update.callId === "string" ? update.callId : "",
          ...(typeof update.name === "string" ? { name: update.name } : {}),
        }),
    });

    const computerContext = options.ctx;
    const computerBox = options.box;
    if (computerContext !== undefined && computerBox !== undefined) {
      this.#computerUse = createComputerUseCoordination({
        ctx: computerContext,
        remoteBox: computerBox,
        actionAuditor: () => options.actionAuditor,
        getConversationId: () => this.getConversationId(),
        resolveBoxId: () => this.resolveBoxId(),
        ...(options.navigationProbe === undefined
          ? {}
          : { initialNavigationProbe: options.navigationProbe }),
      });
      if (this.isComputerUseSubagent && this.subagentModelId !== undefined) {
        this.#computerUse.recordModelId(this.subagentModelId);
      }
    }

    const runtimeHost: SubagentRuntimeHost = {
      getConversationId: () => this.getConversationId(),
      resolveBoxId: () => this.resolveBoxId(),
      emitAsyncTasksChanged: () =>
        this.observation.emitAsyncTasksChanged?.(),
      computerUse: this.#computerUse ?? {
        freeWindow: (subagentAgentId) =>
          options.freeComputerUseWindow?.(subagentAgentId),
      },
      ...(options.now == null ? {} : { now: options.now }),
      ...(options.actionAuditor == null
        ? {}
        : { actionAuditor: options.actionAuditor }),
      ...(options.onComputerUseUsage == null
        ? {}
        : {
          onComputerUseUsage: (event) =>
            this.#onComputerUseUsage?.(event),
        }),
      ...(options.onPendingWakeArmed == null
        ? {}
        : {
          onPendingWakeArmed: (event) =>
            this.#onPendingWakeArmed?.(event),
        }),
      ...(options.onPendingWakeDisarmed == null
        ? {}
        : {
          onPendingWakeDisarmed: (event) =>
            this.#onPendingWakeDisarmed?.(event),
        }),
      isComputerUseSubagentType: (type) =>
        type.replace(/[-_ ]/g, "").toLowerCase()
          === "computeruse",
    };
    this.subagents = createSubagentRuntime(runtimeHost);

    if (options.productionTurnRunShell !== undefined) {
      this.#productionTurnRunShell = createProductionTurnRunShellAdapter({
        ...options.productionTurnRunShell,
        isSubagentRunner: this.isSubagentRunner,
        ...(this.subagentType === undefined ? {} : { subagentType: this.subagentType }),
        ...(this.inheritedRequestSource === undefined
          ? {}
          : { inheritedRequestSource: this.inheritedRequestSource }),
        ...(this.inheritedAutomationId === undefined
          ? {}
          : { inheritedAutomationId: this.inheritedAutomationId }),
        subagents: this.subagents,
        getConversationId: () => this.getConversationId(),
        runGeneration: () => this.#runGeneration,
        setActiveTurnRequestSource: source => {
          this.#activeTurnRequestSource = source;
        },
        setActiveTurnAutomationId: automationId => {
          this.#activeTurnAutomationId = automationId;
        },
        beginAutoReviewUserMessageEpoch: () => this.beginAutoReviewUserMessageEpoch(),
        setActiveRunInterrupted: value => {
          this.#activeRunInterrupted = value;
        },
        setAwaitingUserSelection: value => {
          this.#awaitingUserSelection = value;
        },
        isAwaitingUserSelection: () => this.#awaitingUserSelection,
        emitRunLifecycle: event => this.emitRunLifecycle(event),
        emitUpdate: update => this.options.transport?.onUpdate(update),
        onRunUnwind: () => {
          this.#activeTurnRequestSource = undefined;
          this.#activeTurnAutomationId = undefined;
        },
      });
    }

    const context = options.ctx;
    const box = options.box;
    if (
      context != null
      && typeof (context as Context).with === "function"
      && box != null
      && typeof box.ensureReady === "function"
    ) {
      const shellHost: ShellTerminalWatchHost<Context> = {
        ctx: context,
        ...createShellWatchGeneratedStateProjection({
          getConversationState: () => this.getAgentConversationStateStructure(),
          getBlobStore: () => this.getBlobStore(),
        }),
        getConversationId: () => this.getConversationId(),
        ensureBoxReady: async (pollContext, agentId) => {
          const connection = await box.ensureReady(pollContext, agentId);
          return {
            terminalsFolder: connection.terminalsFolder,
            remoteAccessor: createShellWatchReadAccessor(connection.remoteAccessor),
          };
        },
        getConfirmedUserTurnWatermarkCache: () => this.#shellWatchWatermarkCache,
        setConfirmedUserTurnWatermarkCache: cache => {
          this.#shellWatchWatermarkCache = cache;
        },
        ...(options.now == null ? {} : { now: options.now }),
      };
      const watchesHost: BackgroundWatchesHost = {
        getConversationId: () => this.getConversationId(),
        emitAsyncTasksChanged: () => this.observation.emitAsyncTasksChanged?.(),
        pendingWakeArmedHandler: () => this.#onPendingWakeArmed,
        backgroundShellSettledHandler: () => event => {
          this.#onBackgroundShellSettled?.(
            event as unknown as BackgroundSubagentCompletion,
          );
        },
        notifyBackgroundWorkSettled: completion => {
          this.subagents.notifyBackgroundWorkSettled(
            completion as BackgroundSubagentCompletion,
          );
        },
        cloudAgentWatcher: () => options.cloudAgentWatcher ?? null,
        pollShellTerminalFile: (id, cancelled, settle) => {
          void pollShellTerminalFile(shellHost, id, cancelled, settle);
        },
      };
      this.#backgroundWatches = createBackgroundWatches(watchesHost);
    }
  }

  get state(): RunnerConversationState {
    return this.#state;
  }

  get inactiveTurnAgentStreamPath(): InactiveTurnAgentStreamPath | undefined {
    return this.options.inactiveTurnAgentStreamPath;
  }

  get isTurnAgentStreamActivationReady(): boolean {
    return this.options.activateTurnAgentStream === true
      && this.options.inactiveTurnAgentStreamPath !== undefined;
  }

  runInactiveTurnAgentStream(
    input: InactiveTurnAgentStreamStartInput,
  ): Promise<ConversationStateStructureMessage> {
    if (!this.isTurnAgentStreamActivationReady) {
      throw new Error("turn Agent stream path is inactive");
    }
    return this.options.inactiveTurnAgentStreamPath!.startStream(input);
  }

  runInactiveTurnAgentLifecycle(
    input: InactiveTurnAgentStreamLifecycleInput,
    context: Context,
  ): Promise<ConversationStateStructureMessage> {
    if (!this.isTurnAgentStreamActivationReady) {
      throw new Error("turn Agent stream path is inactive");
    }
    return this.options.inactiveTurnAgentStreamPath!.createLifecycle(input).run(context);
  }

  get runGeneration(): number {
    return this.#runGeneration;
  }

  /** Current generation observed by the production turn-settle owner. */
  get currentRunGeneration(): number {
    return this.#activeRun?.generation ?? this.#runGeneration;
  }

  /** Latest prompt messages retained by the active turn-session executor. */
  getLatestPromptMessages(): readonly unknown[] {
    return this.#latestPromptMessagesGetter?.() ?? [];
  }

  get isComputerUseSubagent(): boolean {
    return this.isSubagentRunner
      && this.subagentType != null
      && this.subagentType.replace(/[-_ ]/g, "").toLowerCase()
        === "computeruse";
  }

  /** Runner-owned computer/browser coordination shared with remote resources. */
  get computerUse(): ReturnType<typeof createComputerUseCoordination<Context>> | undefined {
    return this.#computerUse;
  }

  probeNavigationAfterComputerUse(
    context: Context,
    connection: { readonly remoteAccessor: unknown },
  ): void {
    const probe = this.#computerUse?.getOrCreateNavigationProbe();
    if (probe === undefined) return;
    const detached = typeof context.withDetached === "function"
      ? context.withDetached()
      : context;
    const windowIndex = this.options.getBoxWindowIndex?.(this.resolveBoxId()) ?? 1;
    void probe.probe(detached, connection.remoteAccessor, windowIndex);
  }

  get isBrowserUseSubagent(): boolean {
    return this.isSubagentRunner
      && this.subagentType != null
      && this.subagentType.replace(/[-_ ]/g, "").toLowerCase()
        === "browseruse";
  }

  get isBoxScopedSubagent(): boolean {
    return this.isComputerUseSubagent || this.isBrowserUseSubagent;
  }

  resolveAutoReviewApproval(
    approvalId: string,
    resolution: SandAutoReviewResolution,
  ): boolean {
    return this.autoReviewController?.resolveApproval(
      approvalId,
      resolution,
    ) !== undefined;
  }

  beginAutoReviewUserMessageEpoch(): void {
    this.autoReviewController?.beginUserMessageEpoch();
  }

  expireAutoReviewApprovals(): void {
    this.autoReviewController?.expire("session_end");
  }

  setAgentStore(
    agentStore: unknown,
    agentProfileProvider?: unknown,
  ): void {
    this.#agentStore = agentStore;
    this.#agentProfileProvider = agentProfileProvider;
    this.#runGeneration += 1;
  }

  setAttachmentIngestor(ingest: unknown): void {
    this.#attachmentIngestor = ingest;
  }

  setImagePersister(persistImage: unknown): void {
    this.#persistImage = persistImage;
  }

  setMediaBytesPersister(persistMediaBytes: unknown): void {
    this.#persistMediaBytes = persistMediaBytes;
  }

  setMcp(mcp: unknown): void {
    this.#mcp = mcp;
  }

  setMcpManagement(mcpManagement: unknown): void {
    this.#mcpManagement = mcpManagement;
  }

  setMemoryStore(memoryStore: unknown): void {
    this.#memoryStore = memoryStore;
  }

  setUserMemory(userMemory: unknown): void {
    this.#userMemory = userMemory;
  }

  setProjectMemory(projectMemory: unknown): void {
    this.#projectMemory = projectMemory;
  }

  setMemorySnapshotStore(memorySnapshots: unknown): void {
    this.#memorySnapshots = memorySnapshots;
  }

  setProfilePromptSnapshotStore(profilePromptSnapshots: unknown): void {
    this.#profilePromptSnapshots = profilePromptSnapshots;
  }

  setEpisodeProgress(episodeProgress: unknown): void {
    this.#episodeProgress = episodeProgress;
  }

  setAutomationStore(automationStore: unknown): void {
    this.#automationStore = automationStore;
  }

  setWorkflowStore(workflowStore: unknown): void {
    this.#workflowStore = workflowStore;
  }

  setChannelStore(channelStore: unknown): void {
    this.#channelStore = channelStore;
  }

  setBackgroundSubagentHandler(
    handler: (completion: BackgroundSubagentCompletion) => void,
  ): void {
    this.subagents.setBackgroundSubagentHandler(handler);
  }

  setBackgroundSubagentDispatchHandler(
    handler: Parameters<
      typeof this.subagents.setBackgroundSubagentDispatchHandler
    >[0],
  ): void {
    this.subagents.setBackgroundSubagentDispatchHandler(handler);
  }

  setComputerUseUsageHandler(
    handler: (event: unknown) => void,
  ): void {
    this.#onComputerUseUsage = handler;
  }

  setSubagentEventHandler(
    handler: Parameters<
      typeof this.subagents.setSubagentEventHandler
    >[0],
  ): void {
    this.subagents.setSubagentEventHandler(handler);
  }

  setTurnAwaitHandler(
    handler: Parameters<typeof this.observation.setTurnAwaitHandler>[0],
  ): void {
    this.observation.setTurnAwaitHandler(handler);
  }

  setTurnRetryHandler(
    handler: Parameters<typeof this.observation.setTurnRetryHandler>[0],
  ): void {
    this.observation.setTurnRetryHandler(handler);
  }

  setFirstTokenHandler(
    handler: Parameters<typeof this.observation.setFirstTokenHandler>[0],
  ): void {
    this.observation.setFirstTokenHandler(handler);
  }

  setSendDispatchHandler(
    handler: Parameters<typeof this.observation.setSendDispatchHandler>[0],
  ): void {
    this.observation.setSendDispatchHandler(handler);
  }

  setToolCallDiagnosticHandler(
    handler: Parameters<typeof this.observation.setToolCallDiagnosticHandler>[0],
  ): void {
    this.observation.setToolCallDiagnosticHandler(handler);
  }

  setAsyncTasksEventHandler(
    handler: Parameters<typeof this.observation.setAsyncTasksEventHandler>[0],
  ): void {
    this.observation.setAsyncTasksEventHandler(handler);
  }

  setBackgroundShellHandler(
    handler: (completion: BackgroundSubagentCompletion) => void,
  ): void {
    this.#onBackgroundShellSettled = handler;
  }

  setPendingWakeArmedHandler(
    handler: (event: unknown) => void,
  ): void {
    this.#onPendingWakeArmed = handler;
  }

  setPendingWakeDisarmedHandler(
    handler: (event: unknown) => void,
  ): void {
    this.#onPendingWakeDisarmed = handler;
  }

  listRunningSubagents(): RunningSubagentInfo[] {
    return this.subagents.listRunningSubagents();
  }

  getRunningSubagent(id: string): RunningSubagentInfo | null {
    return this.subagents.getRunningSubagent(id);
  }

  steerSubagent(id: string, message: string) {
    return this.subagents.steerSubagent(id, message);
  }

  abortSubagent(id: string) {
    return this.subagents.abortSubagent(id);
  }

  listSubagents() {
    return this.subagents.listSubagents();
  }

  hasSubagent(id: string): boolean {
    return this.subagents.hasSubagent(id);
  }

  hasRunningSubagents(): boolean {
    return this.subagents.hasRunningSubagents();
  }

  getSubagentOutline(id: string): Promise<readonly unknown[]> {
    return this.subagents.getSubagentOutline(id);
  }

  async getResolvedOutline(): Promise<readonly OutlineItem[]> {
    const outline = deriveOutlineFromConversationState(this.#state);
    const resolved: OutlineItem[] = [];
    for (const item of outline) {
      if (item.kind !== "tool-call" || item.name !== "Task") {
        resolved.push(item);
        continue;
      }
      resolved.push(item);
    }
    return resolved;
  }

  getTranscriptPath(): string | null {
    const folder = this.options.getTranscriptsFolder?.();
    if (folder == null || folder.length === 0) return null;
    const id = this.getTranscriptId();
    const base = folder.endsWith("/") ? folder.slice(0, -1) : folder;
    return `${base}/${id}/${id}.jsonl`;
  }

  getPendingCloudAgentWatchBcIds(): string[] {
    return [
      ...(this.#backgroundWatches?.pendingCloudAgentWatchBcIds()
        ?? this.options.getPendingCloudAgentWatchBcIds?.()
        ?? []),
    ];
  }

  hasRunningBackgroundShellWork(): boolean {
    return this.#backgroundWatches?.hasRunningBackgroundShellWork()
      ?? this.options.hasRunningBackgroundShellWork?.()
      ?? false;
  }

  cancelBackgroundShellRewatches(): void {
    this.#backgroundWatches?.cancelBackgroundShellRewatches();
    this.options.cancelBackgroundShellRewatches?.();
  }

  getPendingShellRewatchIds(): string[] {
    return [
      ...(this.#backgroundWatches?.pendingShellRewatchIds()
        ?? this.options.getPendingShellRewatchIds?.()
        ?? []),
    ];
  }

  isCloudWatchReady(): boolean {
    return this.#backgroundWatches !== undefined
      && this.options.cloudAgentWatcher !== undefined;
  }

  watchCloudAgent(
    id: string,
    options?: { readonly quietOrigin?: string; readonly afterFollowup?: boolean },
  ): void {
    this.#backgroundWatches?.watchCloudAgent(id, options);
  }

  watchBackgroundShell(
    id: string,
    options?: { readonly title?: string; readonly quietOrigin?: string },
  ): void {
    this.#backgroundWatches?.watchBackgroundShell(id, options);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#backgroundWatches?.cancelBackgroundWatches();
    this.options.cancelBackgroundShellRewatches?.();
    this.#backgroundWatches = undefined;
  }

  reset(): void {
    this.#backgroundWatches?.cancelBackgroundWatches();
    this.options.cancelBackgroundShellRewatches?.();
    this.#state = createEmptyState();
    this.#productionConversationStateStructure = undefined;
    if (this.options.blobStore == null) {
      this.#fallbackBlobStore = new InMemoryBlobStore();
      this.#blobStore = this.#fallbackBlobStore;
    }
    this.#confirmedUserTurnWatermarkCache = undefined;
    this.#shellWatchWatermarkCache = undefined;
    this.autoReviewController?.expire("session_end");
    this.#runGeneration += 1;
    this.subagents.reset();
    this.observation.emitAsyncTasksChanged?.();
  }

  listAsyncTasks(): readonly AsyncTask[] {
    return this.observation.listAsyncTasks?.() ?? [];
  }

  getActivitySnapshot(): readonly string[] {
    return this.observation.getActivitySnapshot?.() ?? [];
  }

  getObservedToolCallCount(): number {
    return this.observation.getObservedToolCallCount?.() ?? 0;
  }

  getConversationState(): RunnerConversationState {
    return this.#state;
  }

  /**
   * Returns the generated state snapshot owned by the attached AgentStore.
   * The binary round trip preserves the immutable caller's clone boundary;
   * callers cannot mutate the store's live checkpoint through this value.
   */
  getAgentConversationStateStructure(): ConversationStateStructureMessage {
    if (this.#productionConversationStateStructure !== undefined) {
      return ConversationStateStructure.fromBinary(
        this.#productionConversationStateStructure.toBinary(),
      );
    }
    const owner = this.#agentStore as {
      getConversationStateStructure?: () => ConversationStateStructureMessage;
    } | undefined;
    if (typeof owner?.getConversationStateStructure !== "function") {
      throw new TypeError("production Agent conversation state is not bound");
    }
    const structure = owner.getConversationStateStructure();
    if (structure == null || typeof structure.toBinary !== "function") {
      throw new TypeError("production Agent conversation state is not bound");
    }
    return ConversationStateStructure.fromBinary(structure.toBinary());
  }

  setAgentConversationStateStructure(
    structure: ConversationStateStructureMessage,
  ): void {
    this.#productionConversationStateStructure =
      ConversationStateStructure.fromBinary(structure.toBinary());
  }

  getBlobStore(): BlobStore<unknown> {
    return this.#blobStore;
  }

  createPromptSession(
    onRequestId: (requestId: string) => void,
    options?: Readonly<Record<string, unknown>>,
  ): AgentPromptSession {
    if (this.options.createPromptSession == null) {
      throw new TypeError("production Agent prompt session is not bound");
    }
    return this.options.createPromptSession(onRequestId, options);
  }

  createResourceAccessor(context: unknown): Promise<AgentResourceAccessor> {
    if (this.options.createResourceAccessor == null) {
      return Promise.reject(
        new TypeError("production Agent resource accessor is not bound"),
      );
    }
    return this.options.createResourceAccessor(context);
  }

  createSummarizationHandler(
    summarizationSession: unknown,
    options?: Readonly<{ preserveLatestImage?: boolean }>,
  ): AgentSummarizationHandler {
    if (this.options.createSummarizationHandler == null) {
      throw new TypeError("production Agent summarization handler is not bound");
    }
    return this.options.createSummarizationHandler(summarizationSession, options);
  }

  createConversationActionReceiver(): AgentConversationActionReceiver {
    if (this.options.createConversationActionReceiver == null) {
      throw new TypeError("production Agent conversation action receiver is not bound");
    }
    return this.options.createConversationActionReceiver();
  }

  setConversationState(state: RunnerConversationState): void {
    this.#state = state;
  }

  async wouldRecoverViaPrepend(
    recentUserMessages: readonly {
      readonly id: string;
      readonly text: string;
      readonly confirmed?: boolean;
    }[],
    currentMessageId: string,
    messageId: string,
  ): Promise<boolean> {
    const currentIndex = recentUserMessages.findIndex(
      (message) => message.id === currentMessageId,
    );
    const targetIndex = recentUserMessages.findIndex(
      (message) => message.id === messageId,
    );
    if (currentIndex < 0 || targetIndex < 0) return false;
    this.#confirmedUserTurnWatermarkCache = {
      turnCount: this.#state.turns.length,
      messageId,
    };
    return targetIndex <= currentIndex
      && recentUserMessages[targetIndex]?.confirmed !== true;
  }

  getConversationId(): string {
    return this.options.getAgentId?.()
      ?? this.options.conversationId
      ?? this.#fallbackConversationId;
  }

  resolveBoxId(): string {
    return this.options.getBoxId?.()
      ?? this.options.boxId
      ?? this.getConversationId();
  }

  cloudAgentsDisabledByTeam(): boolean {
    return this.options.isCloudAgentsDisabledByTeam?.() === true;
  }

  isRunAwaitingUserSelection(): boolean {
    return this.#awaitingUserSelection;
  }

  resolveBoxTerminalsFolder(): string | undefined {
    return this.#boxTerminalsFolder ?? this.options.getBoxTerminalsFolder?.();
  }

  setRemoteBoxTerminalsFolder(folder: string): void {
    this.#boxTerminalsFolder = folder;
  }

  resolveBoxBrowser(): {
    readonly display: string;
    readonly cdpUrl: string;
  } | null {
    const windowIndex = this.options.getBoxWindowIndex?.(
      this.resolveBoxId(),
    );
    if (windowIndex === undefined) return null;
    return {
      display: `:${windowIndex}`,
      cdpUrl: `http://127.0.0.1:${BOX_CDP_PORT_BASE + windowIndex}`,
    };
  }

  emitRunLifecycle(event: {
    readonly type: "started" | "ended";
    readonly requestId: string;
  }): void {
    this.options.onRunLifecycle?.(event);
  }

  emitUpdate(update: RunnerUpdate): void {
    const active = this.#activeRun;
    if (
      active != null
      && (
        update.type === "text-delta"
        || update.type === "thinking-delta"
        || update.type === "tool-call"
      )
      && !active.streamOutputProduced
    ) {
      active.streamOutputProduced = true;
      this.#streamOutputProducedThisAttempt = true;
      this.#clearFirstTokenDeadline?.();
      this.#clearFirstTokenDeadline = undefined;
      this.#resetFirstTokenDeadline = undefined;
      this.#observeFirstToken?.();
      this.#observeFirstToken = undefined;
    }

    if (active != null) {
      if (update.type === "text-delta") {
        active.text += update.text;
      } else if (update.type === "send-message") {
        active.sentMessageCount += 1;
        if (
          update.message.type === "widget"
          || update.message.type === "secret-request"
          || update.message.type === "auto-review-approval"
        ) {
          active.awaitingUserSelection = true;
          this.#awaitingUserSelection = true;
        }
      }
    }

    if (this.isComputerUseSubagent && update.type === "turn-ended") {
      this.#computerUse?.recordTurnEnded(update.usage as TurnUsage | undefined);
    }

    this.options.transport?.onUpdate(update);
    if (
      active != null
      && update.type === "react-to-message"
      && this.options.transport?.lastReactionApplied?.() === true
    ) {
      active.reacted = true;
    }
  }

  interrupt(
    reason: string,
    supersede?: { readonly carriesRecovery: boolean },
  ): boolean {
    if (this.#productionTurnRunShell !== undefined) {
      return this.#productionTurnRunShell.interrupt(reason, supersede);
    }
    const active = this.#activeRun;
    if (active == null) return false;
    if (
      !active.dispatched
      && supersede != null
      && (!supersede.carriesRecovery || !active.recoveryShaped)
    ) return false;

    this.#activeRunInterrupted = true;
    active.controller.abort({ intentional: true, reason });
    return true;
  }

  requestQuiesceForUpgrade(): void {
    this.#quiescingForUpgrade = true;
    this.#productionTurnRunShell?.requestQuiesceForUpgrade();
    this.#backgroundWatches?.cancelBackgroundWatches();
    this.options.cancelBackgroundShellRewatches?.();
    this.autoReviewController?.expireForQuiesce();
  }

  isQuiescingForUpgrade(): boolean {
    return this.#quiescingForUpgrade;
  }

  cancelQuiesceForUpgrade(): void {
    this.#quiescingForUpgrade = false;
    this.#productionTurnRunShell?.cancelQuiesceForUpgrade();
    this.autoReviewController?.cancelQuiesce();
  }

  interruptAll(reason: string): boolean {
    const interrupted = this.interrupt(reason);
    for (const session of this.subagents.sessions.values()) {
      session.interrupt(reason);
    }
    return interrupted;
  }

  drainBackgroundSubagents(): Promise<void> {
    return this.subagents.drainBackgroundSubagents();
  }

  async run(
    prompt: string,
    runOptions: {
      readonly inferenceRequestId?: string;
      readonly ackToken?: string;
      readonly messageId?: string;
      readonly recentUserMessages?: readonly {
        readonly id: string;
        readonly text: string;
      }[];
      readonly selectedImages?: readonly unknown[];
      readonly attachedFilePaths?: readonly string[];
      readonly selectedVideos?: readonly unknown[];
      readonly replyContext?: unknown;
      readonly requestSource?: string;
    } = {},
  ): Promise<T | SandAgentRunnerResult | undefined> {
    const trimmed = prompt.trim();
    if (
      trimmed.length === 0
      && (runOptions.selectedImages?.length ?? 0) === 0
      && (runOptions.attachedFilePaths?.length ?? 0) === 0
      && (runOptions.selectedVideos?.length ?? 0) === 0
    ) {
      throw new Error("Prompt cannot be empty.");
    }
    if (this.#quiescingForUpgrade) {
      return {
        text: "",
        sentMessageCount: 0,
        reacted: false,
        aborted: false,
        quiescedForUpgrade: true,
      };
    }

    if (this.#productionTurnRunShell !== undefined) {
      return this.#productionTurnRunShell.run(prompt, runOptions);
    }

    const requestId = runOptions.inferenceRequestId ?? randomUUID();
    const controller = new AbortController();
    const rawTranscriptText = runOptions.messageId == null
      ? undefined
      : runOptions.recentUserMessages?.find(
        (message) => message.id === runOptions.messageId,
      )?.text;
    const active: ActiveRun = {
      requestId,
      controller,
      generation: this.#runGeneration,
      dispatched: false,
      recoveryShaped:
        runOptions.messageId != null
        && (runOptions.selectedImages?.length ?? 0) === 0
        && (runOptions.attachedFilePaths?.length ?? 0) === 0
        && (runOptions.selectedVideos?.length ?? 0) === 0
        && runOptions.replyContext == null
        && rawTranscriptText === trimmed,
      awaitingUserSelection: false,
      quiescedForUpgrade: false,
      text: "",
      sentMessageCount: 0,
      reacted: false,
      streamOutputProduced: false,
    };
    this.#activeRun = active;
    this.#activeRunInterrupted = false;
    this.#awaitingUserSelection = false;
    this.#streamOutputProducedThisAttempt = false;
    this.#activeTurnRequestSource =
      runOptions.requestSource ?? this.inheritedRequestSource;
    this.#activeTurnAutomationId = this.inheritedAutomationId;
    this.emitRunLifecycle({ type: "started", requestId });
    this.observation.turnStarted();

    try {
      await this.options.prepare?.();
      if (controller.signal.aborted) {
        return {
          text: active.text,
          sentMessageCount: active.sentMessageCount,
          reacted: active.reacted,
          aborted: true,
        };
      }

      active.dispatched = true;
      if (this.options.runStep == null) return undefined;
      const maxSteps = this.options.maxSteps ?? SAND_AGENT_MAX_STEPS;
      let result: T | undefined;
      let completed = false;
      for (let step = 0; step < maxSteps; step += 1) {
        const stepResult = await this.options.runStep(step, {
          signal: controller.signal,
          emitUpdate: (update) => this.emitUpdate(update),
          prompt: trimmed,
          runOptions,
          requestId,
          state: this.#state,
          setState: state => {
            this.#state = state;
          },
        });
        if (stepResult.done) {
          result = stepResult.value;
          completed = true;
          break;
        }
      }
      if (!completed) throw new Error(`Agent exceeded ${maxSteps} steps.`);
      await this.options.settle?.(result);

      if (
        active.text.length > 0
        || active.sentMessageCount > 0
        || active.reacted
      ) {
        return {
          text: active.text,
          sentMessageCount: active.sentMessageCount,
          reacted: active.reacted,
          aborted: controller.signal.aborted
            && !active.awaitingUserSelection
            && !active.quiescedForUpgrade,
          ...(active.awaitingUserSelection
            ? { awaitingUserSelection: true }
            : {}),
          ...(active.quiescedForUpgrade
            ? { quiescedForUpgrade: true }
            : {}),
          ...(active.streamOutputProduced
            ? { streamOutputProduced: true }
            : {}),
        };
      }
      return result;
    } finally {
      this.emitRunLifecycle({ type: "ended", requestId });
      if (this.#activeRun === active) this.#activeRun = null;
      this.#activeRunInterrupted = false;
      this.#activeTurnRequestSource = undefined;
      this.#activeTurnAutomationId = undefined;
      this.#latestPromptMessagesGetter = undefined;
      this.#clearFirstTokenDeadline?.();
      this.#clearFirstTokenDeadline = undefined;
      this.#resetFirstTokenDeadline = undefined;
      this.#observeFirstToken = undefined;
    }
  }

  createDeadlineTimer(
    fire: () => void,
    milliseconds: number,
  ): { cancel(): void; restart(): void } {
    let timer = setTimeout(fire, milliseconds);
    timer.unref?.();
    return {
      cancel: () => clearTimeout(timer),
      restart: () => {
        clearTimeout(timer);
        timer = setTimeout(fire, milliseconds);
        timer.unref?.();
      },
    };
  }

  noteMcpToolDiscoveryFailed(_error: unknown): void {
    // Kept separate from a legitimate empty tool listing.
    this.#mcpManagement = {
      previous: this.#mcpManagement,
      discoveryUnavailableForTurn: true,
    };
  }

  stampInheritableRunAttributes<C extends Record<string, unknown>>(
    context: C,
    inferenceRequestId: string,
    turnType: string,
  ): C & { inheritableAttributes: Record<string, string> } {
    const inheritableAttributes = {
      ...(typeof context.inheritableAttributes === "object"
        && context.inheritableAttributes != null
        ? context.inheritableAttributes as Record<string, string>
        : {}),
      "sand.conversation_id": this.getConversationId(),
      "sand.request_id": inferenceRequestId,
      "sand.turn_type": turnType,
      ...(this.isSubagentRunner && this.subagentType != null
        ? { "sand.subagent_type": this.subagentType }
        : {}),
    };
    return { ...context, inheritableAttributes };
  }

  stampCallerTurnRootRequestId(
    span: { setAttribute(key: string, value: string): void },
    inferenceRequestId: string,
  ): void {
    try {
      span.setAttribute("sand.request_id", inferenceRequestId);
    } catch {}
  }

  getTranscriptId(): string {
    return this.subagentTranscriptId ?? this.getConversationId();
  }

  getComputerUseUsageSnapshot(): {
    readonly modelId?: string;
    readonly turnEndedCount: number;
    readonly usage?: unknown;
  } {
    const snapshot = this.#computerUse?.usageSnapshot()
      ?? this.options.getComputerUseUsageSnapshot?.();
    if (snapshot === undefined) return { turnEndedCount: 0 };
    return {
      ...(snapshot.modelId === undefined ? {} : { modelId: snapshot.modelId }),
      turnEndedCount: snapshot.turnEndedCount,
      ...(snapshot.usage === undefined ? {} : { usage: snapshot.usage }),
    };
  }

  getComputerUseAuditActionCounts(): ReadonlyMap<string, number> {
    return this.#computerUse?.auditActionCounts()
      ?? this.options.getComputerUseAuditActionCounts?.()
      ?? new Map();
  }

  auditShellCommand(
    shellKind: string,
    command: string,
    target: "box" | "user_machine",
    attribution: { readonly turnId?: string; readonly boxId?: string } = {},
  ): void {
    this.options.actionAuditor?.record({
      agentId: this.getConversationId(),
      ...(attribution.turnId == null ? {} : { turnId: attribution.turnId }),
      ...(attribution.boxId == null ? {} : { boxId: attribution.boxId }),
      occurredAtMs: (this.options.now ?? Date.now)(),
      action: {
        kind: "shellCommand",
        command,
        shellKind,
        target,
      },
    });
  }
}
