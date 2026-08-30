import type {
  HostRunnerHooks,
  HostRunnerOverrides,
  HostRunnerSession,
} from "./host-runner-composition.js";
import type { SandAgentRunnerOptions } from "./runner/sand-agent-runner.js";
import type { BrowserDriverDependencies } from "./runner/tools/sand-browser-tools.js";
import type { ComputerToolDependencies } from "./runner/tools/sand-computer-tool.js";
import type { HostShellExecutor } from "./runner/host-computer-tool-dependencies.js";
import {
  createTurnToolsetFactoriesForTurn,
  type TurnToolsetHost,
  type TurnToolsetHostFactoryProvider,
  type TurnToolsetTurnInput,
} from "./runner/tools/turn-toolset.js";
import type { TurnMcpProjectionInput } from "./runner/turn-agent-composition.js";
import type { AutoReviewModes } from "./runner/auto-review-gate.js";
import type {
  SandAutoReviewController,
  SandAutoReviewExpiryPolicy,
} from "./runner/sand-auto-review.js";
import type { SandAutoReviewInstructions } from "../shared/sand-auto-review-instructions.js";
import type { AwaitToolOptions } from "../packages/agent/tools/core/await.js";
import type { WebFetchToolDependencies } from "../packages/agent/tools/core/web-fetch.js";
import type { WebSearchToolDependencies } from "../packages/agent/tools/core/web-search.js";
import type { ShellSmartModeApprovalState } from "../packages/agent/tools/core/shell/create-shell-tool.js";
import type { RequestContext } from "../packages/proto/generated/agent/v1/request_context_exec_pb.js";

export type ProductionTurnCancelThisRun = (reason: {
  readonly intentional: boolean;
  readonly reason: string;
}) => void;

export type ProductionTurnEmitUpdate = (
  update: unknown,
  cancelThisRun: ProductionTurnCancelThisRun,
) => void;

export type ProductionRunnerRunStep = NonNullable<
  SandAgentRunnerOptions["runStep"]
>;

export interface ProductionRunnerRunStepInput {
  readonly session: HostRunnerSession;
  readonly hooks: HostRunnerHooks;
  readonly overrides: HostRunnerOverrides;
  /** The complete emitted-constructor option bag assembled by the host. */
  readonly runnerOptions: Readonly<Record<string, unknown>>;
}

/**
 * The shipped lower-level Agent/prompt-stream constructor is bundled into
 * host-main.cjs and has not been recovered as a standalone clean module.
 * Keeping it as a mandatory port prevents the clean host from substituting a
 * no-op step, a synthetic completion, or an artifact import.
 */
export interface ProductionRunnerTurnEngine {
  createRunStep(input: ProductionRunnerRunStepInput): ProductionRunnerRunStep;
}

export type CreateProductionRunnerRunStep = (
  input: ProductionRunnerRunStepInput,
) => ProductionRunnerRunStep;

export function createProductionRunnerRunStepProvider(
  engine: ProductionRunnerTurnEngine,
): CreateProductionRunnerRunStep {
  if (typeof engine?.createRunStep !== "function") {
    throw new TypeError("production Runner turn engine is not bound");
  }

  return input => {
    const runStep = engine.createRunStep(input);
    if (typeof runStep !== "function") {
      throw new TypeError(
        "production Runner turn engine did not create runStep",
      );
    }
    return runStep;
  };
}

import type {
  CloudAgentApi,
  CloudAgentToolContext,
  CloudAgentToolDeps,
} from "./cloud-agents/cloud-agent-tool.js";
import type { BackgroundWatchesHost } from "./runner/background-work.js";
import type { SendMessageDependencies } from "./runner/tools/send-message-tool.js";
import type { SendToAgentDependencies } from "./runner/tools/sand-agent-management-tools.js";
import type { ReactToMessageDependencies } from "./runner/tools/sand-reaction-tool.js";
import type {
  SandStateDependencies,
  SandStateWriter,
} from "./runner/tools/sand-state-tool.js";
import type { McpManagementDependencies } from "./runner/tools/sand-mcp-management-tools.js";
import type { SubagentManagementController } from "./runner/tools/sand-subagent-management-tools.js";

export interface ProductionRunnerRunStepInput {
  /** Creates the exact per-turn props object consumed by buildTurnTools. */
  readonly createTurnToolInputs: CreateProductionTurnToolInputs;
}

export interface ProductionTurnResourceAccessor {
  get(resource: unknown): unknown;
}

export interface ProductionTurnStateHandler {
  readonly [key: string]: unknown;
}

export interface ProductionTurnToolSession {
  getExecutor(...args: readonly unknown[]): unknown;
}

export type ProductionTurnWebSearchDependencies = Omit<
  WebSearchToolDependencies,
  "resourceAccessor"
> & {
  readonly resourceAccessor?: ProductionTurnResourceAccessor;
};

export type ProductionTurnWebFetchDependencies = Omit<
  WebFetchToolDependencies,
  "resourceAccessor"
> & {
  readonly resourceAccessor?: ProductionTurnResourceAccessor;
};

export interface ProductionTurnExternalAwaitInputs {
  readonly resourceAccessor: ProductionTurnResourceAccessor;
  readonly options: AwaitToolOptions;
  readonly promptVersion?: string;
}

export interface ProductionTurnAgentConfig {
  readonly modelId: string;
  readonly [key: string]: unknown;
}

export interface ProductionTurnSummarizationHandler {
  getModelId(): string;
  readonly [key: string]: unknown;
}

export interface ProductionTurnModelInfo {
  readonly modelName?: string;
  readonly [key: string]: unknown;
}

/**
 * Per-turn inputs owned by the Agent turn engine and consumed by buildTurnTools.
 * The host supplies the typed projection callback; it never caches state or
 * sessions across turns.
 */
export interface ProductionTurnToolInputs {
  readonly resourceAccessor: ProductionTurnResourceAccessor;
  readonly stateHandler: ProductionTurnStateHandler;
  readonly toolSession: ProductionTurnToolSession;
  readonly config: ProductionTurnAgentConfig;
  readonly summarizationHandler: ProductionTurnSummarizationHandler;
  readonly parentModelInfo: ProductionTurnModelInfo;
  readonly subagentModels: readonly ProductionTurnModelInfo[];
  readonly subagentConfigs: readonly unknown[];
  readonly fencedToolSet: unknown;
  readonly staticTools: readonly unknown[];
  readonly dynamicTools: readonly unknown[];
  /** Lazy per-turn WebSearch/WebFetch dependencies; factories stay external. */
  readonly webSearch?: ProductionTurnWebSearchDependencies;
  readonly webFetch?: ProductionTurnWebFetchDependencies;
  /** External Await uses the current per-turn accessor and terminal options. */
  readonly externalAwait?: ProductionTurnExternalAwaitInputs;
  /** The immutable per-turn MCP projection, when MCP is available. */
  readonly mcp?: TurnMcpProjectionInput;
  /** Turn-scoped acknowledgement identity for connector cards. */
  readonly ackToken?: string | undefined;
  /** Turn-scoped cancellation identity for connector cards and approvals. */
  readonly cancelThisRun?: ProductionTurnCancelThisRun;
  /** Exact two-argument card/update emitter; absent means fail closed. */
  readonly emitUpdate?: ProductionTurnEmitUpdate;
  /** Optional host-owned projections for concrete per-turn factory slots. */
  readonly createComputerToolDependencies?: (
    input: ProductionTurnToolInputs,
  ) => ComputerToolDependencies<unknown>;
  readonly createScreenshotToolDependencies?: (
    input: ProductionTurnToolInputs,
  ) => ComputerToolDependencies<unknown>;
  readonly createBrowserDriverDependencies?: (
    input: ProductionTurnToolInputs,
  ) => BrowserDriverDependencies<unknown>;
  readonly createBoxShellExecutor?: (
    input: ProductionTurnToolInputs,
  ) => HostShellExecutor;
  /** Named host identities for the remaining immutable factory slots. */
  readonly hostDependencies?: ProductionTurnHostDependencies;
  /** Per-turn concrete factory-input callbacks; factories remain B5-owned. */
  readonly turnToolsetFactoryProvider?: TurnToolsetHostFactoryProvider;
}

export type CreateProductionTurnToolInputs = (
  input: ProductionTurnToolInputs,
) => ProductionTurnToolInputs;

/**
 * The concrete host half of the immutable buildTurnTools boundary.  The
 * provider owns factory construction; this function only supplies the live
 * runner identity/policy fields and projects the already-typed provider into
 * the TurnToolsetHost consumed by buildAgentForRun.  Missing factories remain
 * absent (not replaced with no-op tools), which keeps the unavailable PDF
 * Read branch fail-closed.
 */
export interface ProductionTurnToolsetHostInput {
  readonly turn: TurnToolsetTurnInput;
  readonly props: ProductionTurnToolInputs;
  readonly factoryProvider: TurnToolsetHostFactoryProvider;
  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly isBoxScopedSubagent: boolean;
  readonly isComputerUseSubagent: boolean;
  readonly isBrowserUseSubagent: boolean;
  readonly isSystemPromptOverridden: boolean;
  readonly remoteBoxHasDesktop: boolean;
  readonly getConversationId: () => string;
  readonly getRemoteBoxAvailable: () => boolean;
  readonly cloudAgentsDisabledByTeam: () => boolean;
  readonly spotlightEnabled: () => boolean;
  readonly isDynamicToolsEnabled?: () => boolean;
  readonly isMultitaskEnabled?: () => boolean;
  readonly isSharedRoomBoxToolsEnabled?: () => boolean;
  readonly localToolPermission?: TurnToolsetHost["localToolPermission"];
  readonly recordModelToolName?: TurnToolsetHost["recordModelToolName"];
  readonly toolExecutionTimeoutMs?: TurnToolsetHost["toolExecutionTimeoutMs"];
}

/** Lazy constructor form used before Agent creates its runtime state handle. */
export type ProductionTurnLazyToolsetHostInput = Omit<
  ProductionTurnToolsetHostInput,
  "props"
>;

export function createProductionTurnToolsetHost(
  input: ProductionTurnToolsetHostInput | ProductionTurnLazyToolsetHostInput,
): TurnToolsetHost {
  const factories = !("props" in input)
    ? {}
    : createTurnToolsetFactoriesForTurn(
      input.factoryProvider,
      input.turn,
      input.props,
    );
  return {
    isSubagentRunner: input.isSubagentRunner,
    isSharedRoomRunner: input.isSharedRoomRunner,
    isBoxScopedSubagent: input.isBoxScopedSubagent,
    isComputerUseSubagent: input.isComputerUseSubagent,
    isBrowserUseSubagent: input.isBrowserUseSubagent,
    isSystemPromptOverridden: input.isSystemPromptOverridden,
    remoteBoxHasDesktop: input.remoteBoxHasDesktop,
    getConversationId: input.getConversationId,
    getRemoteBoxAvailable: input.getRemoteBoxAvailable,
    cloudAgentsDisabledByTeam: input.cloudAgentsDisabledByTeam,
    spotlightEnabled: input.spotlightEnabled,
    ...(input.isDynamicToolsEnabled === undefined ? {} : { isDynamicToolsEnabled: input.isDynamicToolsEnabled }),
    ...(input.isMultitaskEnabled === undefined ? {} : { isMultitaskEnabled: input.isMultitaskEnabled }),
    ...(input.isSharedRoomBoxToolsEnabled === undefined ? {} : { isSharedRoomBoxToolsEnabled: input.isSharedRoomBoxToolsEnabled }),
    ...(input.localToolPermission === undefined ? {} : { localToolPermission: input.localToolPermission }),
    ...(input.recordModelToolName === undefined ? {} : { recordModelToolName: input.recordModelToolName }),
    ...(input.toolExecutionTimeoutMs === undefined ? {} : { toolExecutionTimeoutMs: input.toolExecutionTimeoutMs }),
    factoryProvider: input.factoryProvider,
    factories,
  };
}

export interface ProductionTurnHostToolProjections {
  readonly webSearch?: ProductionTurnToolInputs["webSearch"];
  readonly webFetch?: ProductionTurnToolInputs["webFetch"];
  readonly externalAwait?: ProductionTurnToolInputs["externalAwait"];
  readonly mcp?: ProductionTurnToolInputs["mcp"];
  readonly ackToken?: ProductionTurnToolInputs["ackToken"];
  readonly cancelThisRun?: ProductionTurnToolInputs["cancelThisRun"];
  readonly emitUpdate?: ProductionTurnToolInputs["emitUpdate"];
  readonly createComputerToolDependencies?: ProductionTurnToolInputs["createComputerToolDependencies"];
  readonly createScreenshotToolDependencies?: ProductionTurnToolInputs["createScreenshotToolDependencies"];
  readonly createBrowserDriverDependencies?: ProductionTurnToolInputs["createBrowserDriverDependencies"];
  readonly createBoxShellExecutor?: ProductionTurnToolInputs["createBoxShellExecutor"];
  readonly hostDependencies?: ProductionTurnHostDependencies;
  readonly turnToolsetFactoryProvider?: TurnToolsetHostFactoryProvider;
}

/**
 * Host-owned inputs for the factory slots that B5 constructs.  These are
 * deliberately named contracts rather than a factory dictionary: each value
 * retains the session/agent identity and is recreated at the per-turn bridge
 * boundary.  The two runner-instance-owned groups stay optional until their
 * real owner is exposed by the runner composition.
 */
export interface ProductionTurnHostDependencies {
  readonly isMultitaskEnabled: () => boolean;
  readonly sendMessage: SendMessageDependencies<unknown>;
  readonly sendToAgent: SendToAgentDependencies<unknown>;
  readonly reaction: ReactToMessageDependencies;
  readonly agentManagement: {
    create(
      profile: { readonly name: string; readonly description: string },
    ): Promise<{ readonly id: string; readonly name: string }>;
    update(
      agentId: string,
      patch: { readonly name?: string; readonly description?: string },
    ): Promise<{ readonly id: string; readonly name: string } | null>;
  };
  readonly state?: Pick<
    SandStateDependencies,
    "state" | "automationStore" | "workflowStore" | "parseTrigger"
    | "reviewAutomationWrite" | "onListenerRoutineSaved"
  > & { readonly state: SandStateWriter };
  readonly mcpManagement?: McpManagementDependencies;
  readonly cloudAgent?: {
    readonly api: CloudAgentApi;
    readonly launchedIds: Set<string>;
    readonly agentDir: string;
    readonly readBoxFile?: CloudAgentToolDeps["readBoxFile"];
    readonly writeBoxFile: CloudAgentToolDeps["writeBoxFile"];
    readonly cloudAgentWatcher?: BackgroundWatchesHost["cloudAgentWatcher"];
    readonly watch?: CloudAgentToolDeps["watch"];
    readonly reviewAction?: CloudAgentToolDeps["reviewAction"];
  };
  readonly subagentManagement?: SubagentManagementController<unknown>;
  /**
   * Closed host-owned Auto-review identities. Classifier context and
   * per-action reviewers remain optional until their real turn consumers are
   * present; they are intentionally not synthesized here.
   */
  readonly autoReview?: ProductionTurnAutoReviewHostProjection;
}

export interface ProductionTurnAutoReviewHostProjection {
  readonly controller: Pick<SandAutoReviewController, "requestApproval">;
  /** The live session identity used by shell approvals; optional keeps absent host bindings fail-closed. */
  readonly agentId?: string;
  readonly getModes: () => AutoReviewModes;
  readonly getInstructions: () => Pick<
    SandAutoReviewInstructions,
    "allowInstructions" | "blockInstructions"
  > | undefined;
  readonly getApprovalExpiryPolicy: () => SandAutoReviewExpiryPolicy;
  /** Resolved per-turn request context; without it classifier execution stays disabled. */
  readonly requestContext?: Pick<RequestContext, "env">;
  readonly getShellApprovalState?: (
    surface: "host_shell" | "box_shell",
  ) => ShellSmartModeApprovalState | undefined;
  readonly enforceModelFacingShellUiAutomationGuard?: boolean;
  readonly actionAuditor?: {
    record(record: unknown): void;
  };
  readonly localToolPermission?: {
    readonly awaitDesktopStandingDecision: (args: {
      readonly agentId: string;
      readonly toolCallId: string;
      readonly command?: string;
      readonly description?: string;
      readonly signal?: AbortSignal;
    }) => Promise<{
      readonly allowed: boolean;
      readonly reason?: string;
      readonly approvalId?: string;
    }>;
    readonly completeScope: (scope: {
      readonly agentId: string;
      readonly toolCallId: string;
      readonly directionEpoch?: number;
      readonly action?: string;
    }) => void;
  };
  readonly isListenerPlatformConnected?: (
    platform: string,
  ) => Promise<boolean>;
}

export function createProductionTurnToolInputs(
  input: ProductionTurnToolInputs,
  projections?: ProductionTurnHostToolProjections,
): ProductionTurnToolInputs {
  return {
    resourceAccessor: input.resourceAccessor,
    stateHandler: input.stateHandler,
    toolSession: input.toolSession,
    config: input.config,
    summarizationHandler: input.summarizationHandler,
    parentModelInfo: input.parentModelInfo,
    subagentModels: input.subagentModels,
    subagentConfigs: input.subagentConfigs,
    fencedToolSet: input.fencedToolSet,
    staticTools: input.staticTools,
    dynamicTools: input.dynamicTools,
    ...(projections?.webSearch === undefined
      ? input.webSearch === undefined ? {} : { webSearch: input.webSearch }
      : { webSearch: projections.webSearch }),
    ...(projections?.webFetch === undefined
      ? input.webFetch === undefined ? {} : { webFetch: input.webFetch }
      : { webFetch: projections.webFetch }),
    ...(projections?.externalAwait === undefined
      ? input.externalAwait === undefined ? {} : { externalAwait: input.externalAwait }
      : { externalAwait: projections.externalAwait }),
    ...(projections?.mcp === undefined
      ? input.mcp === undefined ? {} : { mcp: input.mcp }
      : { mcp: projections.mcp }),
    ...(projections?.ackToken === undefined
      ? input.ackToken === undefined ? {} : { ackToken: input.ackToken }
      : { ackToken: projections.ackToken }),
    ...(projections?.cancelThisRun === undefined
      ? input.cancelThisRun === undefined ? {} : { cancelThisRun: input.cancelThisRun }
      : { cancelThisRun: projections.cancelThisRun }),
    ...(projections?.emitUpdate === undefined
      ? input.emitUpdate === undefined ? {} : { emitUpdate: input.emitUpdate }
      : { emitUpdate: projections.emitUpdate }),
    ...(projections?.createComputerToolDependencies === undefined
      ? {}
      : { createComputerToolDependencies: projections.createComputerToolDependencies }),
    ...(projections?.createScreenshotToolDependencies === undefined
      ? {}
      : { createScreenshotToolDependencies: projections.createScreenshotToolDependencies }),
    ...(projections?.createBrowserDriverDependencies === undefined
      ? {}
      : { createBrowserDriverDependencies: projections.createBrowserDriverDependencies }),
    ...(projections?.createBoxShellExecutor === undefined
      ? {}
      : { createBoxShellExecutor: projections.createBoxShellExecutor }),
    ...(projections?.hostDependencies === undefined
      ? {}
      : { hostDependencies: projections.hostDependencies }),
    ...(projections?.turnToolsetFactoryProvider === undefined
      ? {}
      : { turnToolsetFactoryProvider: projections.turnToolsetFactoryProvider }),
  };
}
