import {
  SAND_HIDDEN_PROMPT_MARKER,
  SAND_TRUSTED_AUTOMATION_PROMPT_MARKER,
} from "../sand-prompt-markers.js";
import {
  SAND_BOX_AWAIT_SHELL_TOOL_NAME,
  SAND_BOX_READ_TOOL_NAME,
  SAND_BOX_SHELL_TOOL_NAME,
  SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
  SAND_EXTERNAL_READ_TOOL_NAME,
  SAND_EXTERNAL_SHELL_TOOL_NAME,
} from "../../sand-activity.js";
import { resolveSandExternalMachine } from "../../../shared/agents/agent-tool-names.js";
import { SAND_REACT_TO_MESSAGE_TOOL_NAME } from "./sand-reaction-tool.js";
import { SAND_UPDATE_STATE_TOOL_NAME } from "./sand-state-tool.js";
import { SAND_SEND_MESSAGE_TOOL_NAME } from "./send-message-tool.js";
import { createTaskTool } from "../../../packages/agent/tools/task.js";
import type { ToolSetHandle } from "../../../packages/agent/tools/core.js";
import { sandLocalToolScopeKey, sandTurnDirectionEpochKey } from "../../../shared/local-tool-permission-machinery.js";
import type { SandLocalToolAction } from "../../../shared/local-tool-permission.js";
import type { Context } from "../../../packages/context/core.js";
import type { ForwardedUpdate } from "../agent-adapters.js";
import {
  DynamicToolRegistry,
  resolveDynamicDispatchToolName,
} from "../../../packages/agent/tools/mcp/builtin-tools.js";
import {
  createCallMcpTool,
  type CreateCallMcpToolOptions,
} from "../../../packages/agent/tools/mcp/mcp.js";
import { createGetMcpToolsTool } from "../../../packages/agent/tools/mcp/get-mcp-tools.js";
import type { ProductionTurnToolInputs } from "../../runner-production-bridge.js";
import { SAND_BOX_WORKSPACE_ROOT } from "../../cloud-agents/cloud-agent-images.js";
import {
  sandToolCallExecutionTimeoutMs,
  wrapDynamicInvocationToolWithTimeout,
  type McpToolForMeta,
} from "./mcp-meta-tools.js";
import { fencedToolSet } from "./sand-spotlight-tools.js";
import {
  McpDescriptor,
  McpMetaToolOptions,
  McpToolDescriptor,
} from "../../../packages/proto/generated/agent/v1/mcp_pb.js";
import {
  createComputerTool,
  createScreenshotTool,
  type ComputerToolDependencies,
} from "./sand-computer-tool.js";
import {
  createSandBrowserTools,
  type BrowserDriverDependencies,
} from "./sand-browser-tools.js";
import {
  createFileTransferTools,
  type FileTransferController,
} from "./sand-file-transfer-tools.js";
import {
  createRequestBoxHelpTool,
  type BoxHelpDependencies,
} from "./box-help-tool.js";
import {
  createGenerateImageTool,
  type GenerateImageToolDependencies,
} from "../../../packages/agent/tools/core/generate-image.js";
import {
  createWebSearchTool,
  type WebSearchToolDependencies,
} from "../../../packages/agent/tools/core/web-search.js";
import {
  createWebFetchTool,
  type WebFetchToolDependencies,
} from "../../../packages/agent/tools/core/web-fetch.js";
import { createToolCallExecutionTimeoutError } from "../../../packages/agent/tools/common.js";
import {
  createAwaitTool,
  type AwaitToolOptions,
  type AwaitToolResourceAccessor,
} from "../../../packages/agent/tools/core/await.js";
import {
  createSendMessageTool,
  type SendMessageDependencies,
} from "./send-message-tool.js";
import {
  createSendToAgentTool,
  createCreateAgentTool,
  createUpdateAgentTool,
  type AgentManagementDependencies,
  type SendToAgentDependencies,
} from "./sand-agent-management-tools.js";
import {
  createReactToMessageTool,
  type ReactToMessageDependencies,
} from "./sand-reaction-tool.js";
import {
  createReadMessagesTool,
  createSendIMessageTool,
  type MessagesToolDependencies,
} from "./sand-messages-tools.js";
import {
  createSandStateTool,
  type SandStateDependencies,
} from "./sand-state-tool.js";
import {
  createSubagentManagementTools,
  type SubagentManagementController,
} from "./sand-subagent-management-tools.js";
import {
  createMcpManagementTools,
  type McpManagementDependencies,
} from "./sand-mcp-management-tools.js";
import {
  createCloudAgentTool,
  type CloudAgentToolDeps,
} from "../../cloud-agents/cloud-agent-tool.js";
import {
  createReadTool,
  type ReadFormattingOptions,
  type ReadResourceAccessor,
  type ReadToolOptions,
} from "../../../packages/agent/tools/core/read/read.js";
import {
  createShellTool,
  type ShellAutoRunInstructions,
  type ShellToolOptions,
  type ShellToolResourceAccessor,
} from "../../../packages/agent/tools/core/shell/create-shell-tool.js";
import { buildSandShellAutoReviewTargetEnrichment } from "../sand-shell-auto-review-enrichment.js";
import { createSandShellApprovalProvider } from "../sand-auto-review-tool-escalations.js";
import type {
  SandAutoReviewController,
  SandAutoReviewExpiryPolicy,
  SandAutoReviewMode,
} from "../sand-auto-review.js";
import type { RequestContext } from "../../../packages/proto/generated/agent/v1/request_context_exec_pb.js";
import { SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS } from "../sand-auto-review-classifier-run.js";
import {
  createSandMultitaskTodoTool,
} from "../../sand-multitask.js";

export const SAND_EXTERNAL_MACHINE = resolveSandExternalMachine()!;

export const SAND_EXTERNAL_READ_TOOL_DESCRIPTION =
  `Reads a file on ${SAND_EXTERNAL_MACHINE.label}, the same filesystem ${SAND_EXTERNAL_SHELL_TOOL_NAME} acts on. That machine is NOT your own computer: it is reached over a connection the user has to approve, so use ${SAND_BOX_READ_TOOL_NAME} for everything on your own box, including your own files under /home/box.

Text files include line numbers and support offset/limit paging. Image files (jpeg/jpg, png, gif, webp) are returned inline so you can see them. PDF files are converted to text.`;
export const SAND_BOX_READ_TOOL_DESCRIPTION =
  `Reads a file on your own computer (the box), the same filesystem ${SAND_BOX_SHELL_TOOL_NAME} and CopyToBox act on. This is your default surface, including your own files under /home/box. Use ${SAND_EXTERNAL_READ_TOOL_NAME} only for files on ${SAND_EXTERNAL_MACHINE.label}.

Text files include line numbers and support offset/limit paging. Image files (jpeg/jpg, png, gif, webp) are returned inline so you can see them. PDF files are converted to text.`;
export const SAND_COMPUTER_USE_BOX_READ_TOOL_DESCRIPTION =
  `Reads a file on the box, the same filesystem ${SAND_BOX_SHELL_TOOL_NAME} acts on.

Text files include line numbers and support offset/limit paging. Image files (jpeg/jpg, png, gif, webp) are returned inline so you can see them. PDF files are converted to text.`;

export const SHARED_ROOM_TOOL_NAMES = new Set([
  SAND_SEND_MESSAGE_TOOL_NAME,
  SAND_BOX_SHELL_TOOL_NAME,
  SAND_BOX_READ_TOOL_NAME,
  SAND_BOX_AWAIT_SHELL_TOOL_NAME,
  "Screenshot",
]);
export const SHARED_ROOM_TEXT_ONLY_TOOL_NAMES = new Set([
  SAND_SEND_MESSAGE_TOOL_NAME,
]);
export const SAND_FORCED_STATIC_TOOL_NAMES = new Set([
  SAND_UPDATE_STATE_TOOL_NAME,
  SAND_REACT_TO_MESSAGE_TOOL_NAME,
]);

export const SAND_DYNAMIC_TOOL_HINTS: Readonly<Record<string, string>> = {
  CLOUD_AGENT: "Launch and manage Cursor cloud coding agents for repository work.",
  SEARCH_PLUGINS: "Search installable plugins/connectors when a task needs a service.",
  AUTHENTICATE_MCP_SERVER: "Start authentication for a connector that needs auth.",
  COPY_TO_BOX: "Copy a file from the user's computer onto your box.",
  COPY_FROM_BOX: "Copy a file from your box onto the user's computer.",
  REQUEST_BOX_HELP: "Hand your box's desktop to the user for a sign-in or manual step.",
  CHECK_SUBAGENT: "Inspect a running background subagent's status and recent actions.",
  MESSAGE_SUBAGENT: "Send a new instruction into a running background subagent.",
  STOP_SUBAGENT: "Abort a running background subagent.",
};

export const SAND_READ_FORMATTING_OPTIONS = {
  shouldUseFormatCodeblock: false,
  gpt5StyleLineNumbers: false,
  gpt5CodexCatN: false,
  enableLineNumbers: true,
} as const;

export interface ToolExecutionContext {
  readonly directionEpoch?: number;
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
}

export interface ToolMetadata {
  readonly toolCallId: string;
  readonly stateHandler?: unknown;
  readonly workspacePaths?: readonly string[];
}

export interface TurnTool {
  readonly [key: string]: unknown;
  readonly name: string;
  readonly id?: string;
  readonly toolIdentifier?: string;
  readonly description?: string;
  readonly contextType?: {
    readonly type: "static" | "dynamic";
    readonly conciseStaticContext?: string;
  };
  readonly dynamicToolMetaRole?: "invocation" | string;
  execute(...args: readonly unknown[]): Promise<unknown>;
}

type TaskToolParameters = Parameters<typeof createTaskTool>;
type TaskToolConfigFactory = TaskToolParameters[1];
type TaskToolConfig = Awaited<ReturnType<TaskToolConfigFactory>>;
type TaskToolSurface = TurnTool & Record<string, unknown>;
type StreamingTurnTool = TurnTool & {
  execute(
    context: unknown,
    interactionHandler: unknown,
    argumentsStream: AsyncIterable<string>,
    metadata: unknown,
  ): Promise<unknown>;
};

export type TurnToolsetBuildProps = ProductionTurnToolInputs;

export interface TurnToolsetTurnInput {
  /** The exact owner-scoped update relay installed for this prepared turn. */
  readonly emitUpdate?: (update: ForwardedUpdate) => void;
  readonly remoteBoxResourceAccessor?: ProductionTurnToolInputs["resourceAccessor"];
  readonly subagentConfigs?: TaskToolParameters[4];
  readonly autoReviewModes: ToolFactoryContext["autoReviewModes"];
  readonly stateHandler?: unknown;
  readonly toolSession?: TaskToolConfig["promptSession"];
  readonly config?: TaskToolConfig["agentConfig"];
  readonly summarizationHandler?: TaskToolConfig["summarizationHandler"];
  readonly parentModelInfo?: TaskToolParameters[2];
  readonly subagentModels?: TaskToolParameters[5]["subagentModels"];
  readonly geminiVideoAttachedMediaUrlProvider?: unknown;
  readonly cancelThisRun?: (reason: {
    readonly intentional: boolean;
    readonly reason: string;
  }) => void;
  readonly ackToken?: string;
  readonly pauseThisRun?: () => void;
  readonly isRunAwaitingUserSelection?: () => boolean;
  readonly endThisRunAwaitingUser?: (reason: string) => void;
  /** Per-turn MCP descriptors used by the generated discovery/call pair. */
  readonly mcpTools?: readonly McpToolForMeta[];
  /** Optional live Shell Smart Mode identities, supplied per turn by the host. */
  readonly shellAutoReview?: {
    readonly host?: TurnShellAutoReviewInput;
    readonly box?: TurnShellAutoReviewInput;
  };
}

export interface TurnShellAutoReviewInput {
  readonly mode: SandAutoReviewMode;
  readonly agentId: string;
  readonly surface: "host_machine" | "isolated_box";
  readonly requestContext: Pick<RequestContext, "env">;
  readonly controller?: Pick<SandAutoReviewController, "requestApproval">;
  readonly getApprovalExpiryPolicy: () => SandAutoReviewExpiryPolicy;
  readonly smartModeShellApprovalState?: {
    readonly getIdentity: () => string | undefined;
    readonly markSideEffectStart: () => void;
  };
  readonly userAutoRunInstructions?: ShellAutoRunInstructions;
  readonly projectAutoRunInstructions?: ShellAutoRunInstructions;
  readonly enforceModelFacingShellUiAutomationGuard: boolean;
}

/**
 * Resolves the live shell review identities at the same lazy per-turn point as
 * the shell resource accessor.  Explicit turn values win; an incomplete host
 * projection produces no Smart Mode options rather than synthetic approval or
 * request-context bindings.
 */
export function resolveTurnShellAutoReviewInputs(
  turn: TurnToolsetTurnInput,
  props: TurnToolsetBuildProps,
): TurnToolsetTurnInput["shellAutoReview"] {
  if (turn.shellAutoReview !== undefined) return turn.shellAutoReview;
  const autoReview = props.hostDependencies?.autoReview;
  const requestContext = autoReview?.requestContext;
  const agentId = autoReview?.agentId;
  if (autoReview === undefined || requestContext === undefined || agentId === undefined) {
    return undefined;
  }
  const modes = autoReview.getModes();
  const instructions = autoReview.getInstructions();
  const makeReview = (
    mode: SandAutoReviewMode,
    surface: TurnShellAutoReviewInput["surface"],
    approvalSurface: "host_shell" | "box_shell",
  ): TurnShellAutoReviewInput | undefined => {
    if (mode === "off") return undefined;
    const approvalState = autoReview.getShellApprovalState?.(approvalSurface);
    return {
      mode,
      agentId,
      surface,
      requestContext,
      controller: autoReview.controller,
      getApprovalExpiryPolicy: autoReview.getApprovalExpiryPolicy,
      ...(approvalState === undefined
        ? {}
        : {
            smartModeShellApprovalState: approvalState,
          }),
      ...(instructions === undefined
        ? {}
        : {
            userAutoRunInstructions: {
              allowInstructions: instructions.allowInstructions,
              blockInstructions: instructions.blockInstructions,
            },
          }),
      enforceModelFacingShellUiAutomationGuard:
        autoReview.enforceModelFacingShellUiAutomationGuard
        ?? (modes.hostShell === "enforce" || modes.computer === "enforce"),
    };
  };
  const host = makeReview(modes.hostShell, "host_machine", "host_shell");
  const box = makeReview(modes.boxShell, "isolated_box", "box_shell");
  return host === undefined && box === undefined
    ? undefined
    : {
        ...(host === undefined ? {} : { host }),
        ...(box === undefined ? {} : { box }),
      };
}

/**
 * Projects the exact immutable Shell Smart Mode options without creating host
 * identities. The resource accessor and review values are both per-turn; when
 * either is absent, the caller leaves the Shell branch fail-closed.
 */
export function createTurnShellAutoReviewOptions(input: {
  readonly resourceAccessor: ShellToolResourceAccessor;
  readonly options: ShellToolOptions;
  readonly review?: TurnShellAutoReviewInput;
}): ShellToolOptions {
  const { review } = input;
  if (review === undefined) return input.options;
  return {
    ...input.options,
    requestContext: review.requestContext,
    smartModeClassifierMode: review.mode === "enforce",
    smartModeClassifierShadowMode: review.mode === "shadow",
    smartModeApprovalSurface: review.surface,
    ...(review.controller === undefined || review.mode !== "enforce"
      ? {}
      : {
          smartModeApprovalProvider: createSandShellApprovalProvider({
            controller: review.controller,
            agentId: review.agentId,
            surface: review.surface === "host_machine" ? "host_shell" : "box_shell",
            getExpiryPolicy: review.getApprovalExpiryPolicy,
          }),
        }),
    smartModeShellTargetEnrichmentProvider: (context, args) =>
      buildSandShellAutoReviewTargetEnrichment(context, {
        resourceAccessor: args.resourceAccessor,
        command: args.command,
        ...(args.workingDirectory === undefined
          ? {}
          : { workingDirectory: args.workingDirectory }),
        toolCallId: args.toolCallId,
      }),
    ...(review.smartModeShellApprovalState === undefined
      ? {}
      : { smartModeShellApprovalState: review.smartModeShellApprovalState }),
    ...(review.userAutoRunInstructions === undefined
      ? {}
      : { userAutoRunInstructions: review.userAutoRunInstructions }),
    ...(review.projectAutoRunInstructions === undefined
      ? {}
      : { projectAutoRunInstructions: review.projectAutoRunInstructions }),
    smartModeClassifierMaxAttempts: SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS,
    suppressSmartModeClassifierTelemetryIds: true,
    loadSmartModeWorkspacePermissionFiles: false,
    disableSmartModeAllowlistPrecheck: true,
    enforceModelFacingShellUiAutomationGuard:
      review.enforceModelFacingShellUiAutomationGuard,
  };
}

export interface LocalToolPermission {
  completeScope(scope: {
    agentId: string;
    toolCallId: string;
    directionEpoch?: number;
    action?: string;
  }): void;
}

export function withDynamicToolPlacement<T extends TurnTool>(tool: T): T {
  if (SAND_FORCED_STATIC_TOOL_NAMES.has(tool.name)) {
    return {
      ...tool,
      contextType: { type: "static" },
    };
  }
  if (tool.contextType !== undefined) return tool;
  if (tool.toolIdentifier === undefined) return tool;
  const hint = SAND_DYNAMIC_TOOL_HINTS[tool.toolIdentifier];
  if (hint === undefined) return tool;
  return {
    ...tool,
    contextType: {
      type: "dynamic",
      conciseStaticContext: hint,
    },
  };
}

export function withLocalToolScope<T extends TurnTool>(
  tool: T,
  agentId: string,
  permission: LocalToolPermission | undefined,
  action?: SandLocalToolAction,
): T {
  if (permission === undefined) return tool;
  return {
    ...tool,
    async execute(
      context: Context,
      interactionHandler: unknown,
      argsStream: AsyncIterable<string>,
      metadata: ToolMetadata,
    ) {
      const directionEpoch = context.get(sandTurnDirectionEpochKey);
      const scope = {
        agentId,
        toolCallId: metadata.toolCallId,
        ...(directionEpoch === undefined
          ? {}
          : { directionEpoch }),
        ...(action === undefined ? {} : { action }),
      };
      try {
        return await tool.execute(
          context.with(sandLocalToolScopeKey, scope),
          interactionHandler,
          argsStream,
          metadata,
        );
      } finally {
        permission.completeScope(scope);
      }
    },
  };
}

export function withRecordedToolCallNames<T extends TurnTool>(
  tool: T,
  record: (toolCallId: string, toolName: string) => void,
): T {
  return {
    ...tool,
    execute(...args: readonly unknown[]) {
      const metadata = args.at(-1);
      if (
        typeof metadata !== "object"
        || metadata === null
        || !("toolCallId" in metadata)
        || typeof metadata.toolCallId !== "string"
      ) throw new TypeError("tool call metadata is not bound");
      record(metadata.toolCallId, tool.name);
      return tool.execute(...args);
    },
  };
}

export function withToolTimeout<T extends TurnTool>(
  tool: T,
  timeoutMs: number,
  createTimeoutError: () => Error = () =>
    createToolCallExecutionTimeoutError({
      toolName: tool.name,
      executionTimeoutMs: timeoutMs,
    }),
): T {
  return {
    ...tool,
    async execute(...args: readonly unknown[]) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          tool.execute(...args),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(createTimeoutError()),
              timeoutMs,
            );
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}

export interface ToolFactoryContext {
  readonly autoReviewModes: {
    readonly hostShell: string;
    readonly boxShell: string;
    readonly mcp: string;
    readonly computer: string;
    readonly automationWrite: string;
    readonly cloudAgent: string;
    readonly subagentLaunch: string;
  };
  readonly stateHandler?: unknown;
}

export interface TurnToolFactories {
  task?(): TurnTool;
  multitask?(): TurnTool;
  sendMessage?(): TurnTool;
  sendToAgent?(): TurnTool;
  reaction?(): TurnTool;
  createAgent?(): TurnTool;
  updateAgent?(): TurnTool;
  updateState?(): TurnTool;
  externalShell?(): TurnTool | undefined;
  externalRead?(): TurnTool;
  externalAwait?(): TurnTool;
  readMessages?(): TurnTool;
  sendIMessage?(): TurnTool;
  webSearch?(): TurnTool;
  webFetch?(): TurnTool;
  generateImage?(): TurnTool;
  cloudAgent?(): TurnTool;
  boxShell?(): TurnTool | undefined;
  boxRead?(): TurnTool;
  boxAwait?(): TurnTool;
  fileTransfer?(): readonly TurnTool[];
  computer?(): TurnTool;
  browser?(): readonly TurnTool[];
  screenshot?(): TurnTool;
  requestBoxHelp?(): TurnTool;
  mcpMeta?(dynamicToolRegistry?: DynamicToolRegistry): readonly TurnTool[];
  mcpManagement?(): readonly TurnTool[];
  subagentManagement?(): readonly TurnTool[];
}

export type TurnTaskToolParameters = Parameters<typeof createTaskTool>;

/**
 * Exact per-turn inputs required by the shipped Task constructor. Keeping
 * this contract concrete prevents the production path from supplying a
 * generic factory map or losing resource/state/session identity.
 */
export interface TurnTaskToolFactoryInput {
  readonly resourceAccessor: TurnTaskToolParameters[0];
  readonly getTaskToolConfig: TurnTaskToolParameters[1];
  readonly parentModelInfo: TurnTaskToolParameters[2];
  readonly stateHandler: TurnTaskToolParameters[3];
  readonly subagentConfigs: TurnTaskToolParameters[4];
  readonly options: TurnTaskToolParameters[5];
}

/** Exact two-argument owner used by the shipped Multitask TodoWrite tool. */
export interface TurnMultitaskToolFactoryInput {
  readonly resourceAccessor: Parameters<typeof createSandMultitaskTodoTool>[0];
  readonly stateHandler: Parameters<typeof createSandMultitaskTodoTool>[1];
}

export interface TurnMcpMetaToolFactoryInput {
  readonly resourceAccessor: TaskToolParameters[0];
  readonly getMcpTools: () => readonly McpToolForMeta[];
  readonly callOptions: Omit<
    CreateCallMcpToolOptions,
    "resourceAccessor" | "mcpMetaToolOptions" | "dynamicToolRegistry"
  >;
  readonly discoveryOptions?: {
    readonly projectDir?: string;
    readonly allowInteractiveMcpAuth?: boolean;
    readonly isMcpToolBlocked?: CreateCallMcpToolOptions["isMcpToolBlocked"];
  };
}

export interface TurnComputerToolFactoryInput {
  readonly dependencies: ComputerToolDependencies<unknown>;
}

export interface TurnBrowserToolFactoryInput {
  readonly dependencies: BrowserDriverDependencies<unknown>;
}

export interface TurnFileTransferToolFactoryInput {
  readonly controller: FileTransferController;
}

export interface TurnBoxHelpToolFactoryInput {
  readonly dependencies: BoxHelpDependencies<unknown>;
}

export interface TurnGenerateImageToolFactoryInput {
  readonly dependencies: GenerateImageToolDependencies;
}

export interface TurnWebSearchToolFactoryInput {
  readonly dependencies: WebSearchToolDependencies;
}

export interface TurnWebFetchToolFactoryInput {
  readonly dependencies: WebFetchToolDependencies;
}

export interface TurnAwaitToolFactoryInput {
  readonly resourceAccessor: AwaitToolResourceAccessor;
  readonly options: AwaitToolOptions;
  readonly promptVersion?: string;
}

export interface TurnShellToolFactoryInput {
  /** Fresh per-turn accessor from which createShellTool resolves shellStreamExecutorResource. */
  readonly resourceAccessor: ShellToolResourceAccessor;
  readonly options?: ShellToolOptions;
}

export interface TurnReadToolFactoryInput {
  readonly resourceAccessor: ReadResourceAccessor;
  readonly formattingOptions: ReadFormattingOptions;
  readonly promptVersion?: string;
  readonly options?: ReadToolOptions;
}

export interface TurnSendMessageToolFactoryInput {
  readonly dependencies: SendMessageDependencies<Context>;
}

export interface TurnSendToAgentToolFactoryInput {
  readonly dependencies: SendToAgentDependencies<unknown>;
}

export interface TurnReactionToolFactoryInput {
  readonly dependencies: ReactToMessageDependencies;
}

export interface TurnMessagesToolFactoryInput {
  readonly dependencies: MessagesToolDependencies;
}

export interface TurnAgentManagementToolFactoryInput {
  readonly dependencies: AgentManagementDependencies;
}

export interface TurnStateToolFactoryInput {
  readonly dependencies: SandStateDependencies;
}

export interface TurnSubagentManagementToolFactoryInput {
  readonly controller: SubagentManagementController<unknown>;
}

export interface TurnMcpManagementToolFactoryInput {
  readonly management: McpManagementDependencies;
  readonly getRequestingAgentId?: Parameters<typeof createMcpManagementTools>[1];
  readonly isAwaitingUserSelection?: Parameters<typeof createMcpManagementTools>[2];
  readonly isMultiAccountEnabled?: Parameters<typeof createMcpManagementTools>[3];
  readonly emitConnectorCard?: Parameters<typeof createMcpManagementTools>[4];
}

export interface TurnCloudAgentToolFactoryInput {
  readonly dependencies: CloudAgentToolDeps;
}

export interface TurnToolsetFactoryInputs {
  readonly task?: TurnTaskToolFactoryInput;
  readonly multitask?: TurnMultitaskToolFactoryInput;
  readonly mcpMeta?: TurnMcpMetaToolFactoryInput;
  readonly computer?: TurnComputerToolFactoryInput;
  readonly browser?: TurnBrowserToolFactoryInput;
  readonly screenshot?: TurnComputerToolFactoryInput;
  readonly fileTransfer?: TurnFileTransferToolFactoryInput;
  readonly requestBoxHelp?: TurnBoxHelpToolFactoryInput;
  readonly generateImage?: TurnGenerateImageToolFactoryInput;
  readonly webSearch?: TurnWebSearchToolFactoryInput;
  readonly webFetch?: TurnWebFetchToolFactoryInput;
  readonly externalAwait?: TurnAwaitToolFactoryInput;
  readonly boxAwait?: TurnAwaitToolFactoryInput;
  readonly externalShell?: TurnShellToolFactoryInput;
  readonly externalRead?: TurnReadToolFactoryInput;
  readonly boxShell?: TurnShellToolFactoryInput;
  readonly boxRead?: TurnReadToolFactoryInput;
  readonly sendMessage?: TurnSendMessageToolFactoryInput;
  readonly sendToAgent?: TurnSendToAgentToolFactoryInput;
  readonly reaction?: TurnReactionToolFactoryInput;
  readonly messages?: TurnMessagesToolFactoryInput;
  readonly agentManagement?: TurnAgentManagementToolFactoryInput;
  readonly state?: TurnStateToolFactoryInput;
  readonly subagentManagement?: TurnSubagentManagementToolFactoryInput;
  readonly mcpManagement?: TurnMcpManagementToolFactoryInput;
  readonly cloudAgent?: TurnCloudAgentToolFactoryInput;
}

/** Host-facing per-turn projection; resource/session identities stay fresh. */
export interface TurnToolsetHostFactoryProvider {
  readonly createTaskToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnTaskToolFactoryInput;
  readonly createMultitaskToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnMultitaskToolFactoryInput;
  readonly createMcpMetaToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnMcpMetaToolFactoryInput;
  readonly createComputerToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnComputerToolFactoryInput;
  readonly createBrowserToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnBrowserToolFactoryInput;
  readonly createScreenshotToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnComputerToolFactoryInput;
  readonly createFileTransferToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnFileTransferToolFactoryInput;
  readonly createRequestBoxHelpToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnBoxHelpToolFactoryInput;
  readonly createGenerateImageToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnGenerateImageToolFactoryInput;
  readonly createWebSearchToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnWebSearchToolFactoryInput;
  readonly createWebFetchToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnWebFetchToolFactoryInput;
  readonly createExternalAwaitToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnAwaitToolFactoryInput;
  readonly createBoxAwaitToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnAwaitToolFactoryInput;
  readonly createExternalShellToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnShellToolFactoryInput | undefined;
  /** Read is source-closed for ordinary text/images; PDF extraction remains an explicit option. */
  readonly createExternalReadToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnReadToolFactoryInput | undefined;
  readonly createBoxShellToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnShellToolFactoryInput | undefined;
  readonly createBoxReadToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnReadToolFactoryInput | undefined;
  readonly createSendMessageToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnSendMessageToolFactoryInput;
  readonly createSendToAgentToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnSendToAgentToolFactoryInput;
  readonly createReactionToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnReactionToolFactoryInput;
  readonly createMessagesToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnMessagesToolFactoryInput;
  readonly createAgentManagementToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnAgentManagementToolFactoryInput;
  readonly createStateToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnStateToolFactoryInput;
  readonly createSubagentManagementToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnSubagentManagementToolFactoryInput;
  readonly createMcpManagementToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnMcpManagementToolFactoryInput;
  readonly createCloudAgentToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnCloudAgentToolFactoryInput;
}

function isTurnTool<T extends object>(value: T): value is T & TurnTool {
  return typeof Reflect.get(value, "name") === "string"
    && typeof Reflect.get(value, "execute") === "function";
}

function asTurnTool<T extends object>(value: T): T & TurnTool {
  if (!isTurnTool(value)) {
    throw new TypeError("turn tool factory returned an invalid tool");
  }
  return value;
}

function asGeneratedMcpMetaToolOptions(
  tools: readonly McpToolForMeta[],
): McpMetaToolOptions {
  const descriptors = new Map<string, McpDescriptor>();
  for (const tool of tools) {
    let descriptor = descriptors.get(tool.providerIdentifier);
    if (descriptor === undefined) {
      descriptor = new McpDescriptor({
        serverIdentifier: tool.providerIdentifier,
        serverName: tool.providerIdentifier,
        ...(typeof tool.plugin === "string" ? { plugin: tool.plugin } : {}),
        ...(typeof tool.marketplace === "string"
          ? { marketplace: tool.marketplace }
          : {}),
        ...(tool.pluginId === undefined ? {} : { pluginDbId: tool.pluginId }),
        ...(tool.marketplaceId === undefined
          ? {}
          : { marketplaceId: tool.marketplaceId }),
      });
      descriptors.set(tool.providerIdentifier, descriptor);
    }
    descriptor.tools.push(new McpToolDescriptor({
      toolName: tool.toolName,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(typeof tool.inputSchema === "string"
        ? { inputSchemaJson: tool.inputSchema }
        : {}),
    }));
  }
  for (const descriptor of descriptors.values()) {
    descriptor.tools.sort((left, right) => left.toolName.localeCompare(right.toolName));
  }
  return new McpMetaToolOptions({
    enabled: true,
    mcpDescriptors: [...descriptors.values()],
  });
}

/** Creates the artifact-backed Task factory from exact constructor inputs. */
export function createTurnTaskToolFactory(
  input: TurnTaskToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createTaskTool(
    input.resourceAccessor,
    input.getTaskToolConfig,
    input.parentModelInfo,
    input.stateHandler,
    input.subagentConfigs,
    input.options,
  ));
}

/** Creates the exact shipped Multitask TodoWrite owner; plan synchronization
 * remains inside that owner and therefore retains its worker/error boundary. */
export function createTurnMultitaskToolFactory(
  input: TurnMultitaskToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createSandMultitaskTodoTool(
    input.resourceAccessor,
    input.stateHandler,
  ));
}

/**
 * Creates the artifact-backed MCP discovery/call pair. The descriptor getter
 * is evaluated for each tool build, and the dynamic registry is supplied by
 * buildTurnTools after its placement gate has run.
 */
export function createTurnMcpMetaToolFactory(
  input: TurnMcpMetaToolFactoryInput,
): (dynamicToolRegistry?: DynamicToolRegistry) => readonly TurnTool[] {
  return (dynamicToolRegistry) => {
    const mcpMetaToolOptions = asGeneratedMcpMetaToolOptions(input.getMcpTools());
    const discovery = createGetMcpToolsTool(mcpMetaToolOptions, {
      resourceAccessor: input.resourceAccessor,
      ...(input.discoveryOptions?.projectDir === undefined
        ? {}
        : { projectDir: input.discoveryOptions.projectDir }),
      ...(input.discoveryOptions?.allowInteractiveMcpAuth === undefined
        ? {}
        : { allowInteractiveMcpAuth: input.discoveryOptions.allowInteractiveMcpAuth }),
      ...(input.discoveryOptions?.isMcpToolBlocked === undefined
        ? {}
        : { isMcpToolBlocked: input.discoveryOptions.isMcpToolBlocked }),
      ...(dynamicToolRegistry === undefined ? {} : { dynamicToolRegistry }),
    });
    const call = createCallMcpTool({
      ...input.callOptions,
      resourceAccessor: input.resourceAccessor,
      mcpMetaToolOptions,
      ...(dynamicToolRegistry === undefined ? {} : { dynamicToolRegistry }),
    });
    return [asTurnTool(discovery), asTurnTool(call)];
  };
}

export function createTurnComputerToolFactory(
  input: TurnComputerToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createComputerTool(input.dependencies));
}

export function createTurnScreenshotToolFactory(
  input: TurnComputerToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createScreenshotTool(input.dependencies));
}

export function createTurnBrowserToolFactory(
  input: TurnBrowserToolFactoryInput,
): () => readonly TurnTool[] {
  return () => createSandBrowserTools(input.dependencies).map(asTurnTool);
}

export function createTurnFileTransferToolFactory(
  input: TurnFileTransferToolFactoryInput,
): () => readonly TurnTool[] {
  return () => createFileTransferTools(input.controller).map(asTurnTool);
}

export function createTurnBoxHelpToolFactory(
  input: TurnBoxHelpToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createRequestBoxHelpTool(input.dependencies));
}

export function createTurnGenerateImageToolFactory(
  input: TurnGenerateImageToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createGenerateImageTool(input.dependencies));
}

export function createTurnWebSearchToolFactory(
  input: TurnWebSearchToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createWebSearchTool(input.dependencies));
}

export function createTurnWebFetchToolFactory(
  input: TurnWebFetchToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createWebFetchTool(input.dependencies));
}

export function createTurnAwaitToolFactory(
  input: TurnAwaitToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createAwaitTool(
    input.resourceAccessor,
    input.options,
    input.promptVersion,
  ));
}

export function createTurnShellToolFactory(
  input: TurnShellToolFactoryInput,
): () => TurnTool | undefined {
  return () => {
    const tool = createShellTool(input.resourceAccessor, input.options);
    return tool === undefined ? undefined : asTurnTool(tool);
  };
}

export function createTurnReadToolFactory(
  input: TurnReadToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createReadTool(
    input.resourceAccessor,
    input.formattingOptions,
    input.promptVersion,
    input.options,
  ));
}

export function createTurnSendMessageToolFactory(
  input: TurnSendMessageToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createSendMessageTool(input.dependencies));
}

export function createTurnSendToAgentToolFactory(
  input: TurnSendToAgentToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createSendToAgentTool(input.dependencies));
}

export function createTurnReactionToolFactory(
  input: TurnReactionToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createReactToMessageTool(input.dependencies));
}

export function createTurnReadMessagesToolFactory(
  input: TurnMessagesToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createReadMessagesTool(input.dependencies));
}

export function createTurnSendIMessageToolFactory(
  input: TurnMessagesToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createSendIMessageTool(input.dependencies));
}

export function createTurnCreateAgentToolFactory(
  input: TurnAgentManagementToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createCreateAgentTool(input.dependencies));
}

export function createTurnUpdateAgentToolFactory(
  input: TurnAgentManagementToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createUpdateAgentTool(input.dependencies));
}

export function createTurnStateToolFactory(
  input: TurnStateToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createSandStateTool(input.dependencies));
}

export function createTurnSubagentManagementToolFactory(
  input: TurnSubagentManagementToolFactoryInput,
): () => readonly TurnTool[] {
  return () => createSubagentManagementTools(input.controller).map(asTurnTool);
}

export function createTurnMcpManagementToolFactory(
  input: TurnMcpManagementToolFactoryInput,
): () => readonly TurnTool[] {
  return () => createMcpManagementTools(
    input.management,
    input.getRequestingAgentId,
    input.isAwaitingUserSelection,
    input.isMultiAccountEnabled,
    input.emitConnectorCard,
  ).map(asTurnTool);
}

export function createTurnCloudAgentToolFactory(
  input: TurnCloudAgentToolFactoryInput,
): () => TurnTool {
  return () => asTurnTool(createCloudAgentTool(input.dependencies));
}

/**
 * Concrete producer for the currently closed turn-tool owners. Read's
 * ordinary text/image path is source-closed; PDF extraction remains an
 * explicit injected option. Shell uses the released shellStreamExecutorResource boundary;
 * Web, image, and await use their exact per-turn contracts above.
 * Multitask uses the source-closed UpdateTodos/plan-sync owner and remains
 * absent unless its exact per-turn resource/state inputs are supplied.
 */
export function createTurnToolsetFactories(
  input: TurnToolsetFactoryInputs,
): Pick<
  TurnToolFactories,
  "task" | "mcpMeta" | "computer" | "browser" | "screenshot"
  | "fileTransfer" | "requestBoxHelp" | "generateImage" | "webSearch" | "webFetch" | "externalAwait"
  | "boxAwait" | "externalShell" | "externalRead" | "boxShell" | "boxRead"
  | "sendMessage" | "sendToAgent" | "reaction" | "readMessages" | "sendIMessage" | "createAgent" | "updateAgent" | "updateState"
  | "subagentManagement"
  | "mcpManagement" | "cloudAgent"
> {
  return {
    ...(input.task === undefined
      ? {}
      : { task: createTurnTaskToolFactory(input.task) }),
    ...(input.multitask === undefined
      ? {}
      : { multitask: createTurnMultitaskToolFactory(input.multitask) }),
    ...(input.mcpMeta === undefined
      ? {}
      : { mcpMeta: createTurnMcpMetaToolFactory(input.mcpMeta) }),
    ...(input.computer === undefined
      ? {}
      : { computer: createTurnComputerToolFactory(input.computer) }),
    ...(input.browser === undefined
      ? {}
      : { browser: createTurnBrowserToolFactory(input.browser) }),
    ...(input.screenshot === undefined
      ? {}
      : { screenshot: createTurnScreenshotToolFactory(input.screenshot) }),
    ...(input.fileTransfer === undefined
      ? {}
      : { fileTransfer: createTurnFileTransferToolFactory(input.fileTransfer) }),
    ...(input.requestBoxHelp === undefined
      ? {}
      : { requestBoxHelp: createTurnBoxHelpToolFactory(input.requestBoxHelp) }),
    ...(input.generateImage === undefined
      ? {}
      : { generateImage: createTurnGenerateImageToolFactory(input.generateImage) }),
    ...(input.webSearch === undefined
      ? {}
      : { webSearch: createTurnWebSearchToolFactory(input.webSearch) }),
    ...(input.webFetch === undefined
      ? {}
      : { webFetch: createTurnWebFetchToolFactory(input.webFetch) }),
    ...(input.externalAwait === undefined
      ? {}
      : { externalAwait: createTurnAwaitToolFactory(input.externalAwait) }),
    ...(input.boxAwait === undefined
      ? {}
      : { boxAwait: createTurnAwaitToolFactory(input.boxAwait) }),
    ...(input.externalShell === undefined
      ? {}
      : { externalShell: createTurnShellToolFactory(input.externalShell) }),
    ...(input.externalRead === undefined
      ? {}
      : { externalRead: createTurnReadToolFactory(input.externalRead) }),
    ...(input.boxShell === undefined
      ? {}
      : { boxShell: createTurnShellToolFactory(input.boxShell) }),
    ...(input.boxRead === undefined
      ? {}
      : { boxRead: createTurnReadToolFactory(input.boxRead) }),
    ...(input.sendMessage === undefined
      ? {}
      : { sendMessage: createTurnSendMessageToolFactory(input.sendMessage) }),
    ...(input.sendToAgent === undefined
      ? {}
      : { sendToAgent: createTurnSendToAgentToolFactory(input.sendToAgent) }),
    ...(input.reaction === undefined
      ? {}
      : { reaction: createTurnReactionToolFactory(input.reaction) }),
    ...(input.messages === undefined
      ? {}
      : {
        readMessages: createTurnReadMessagesToolFactory(input.messages),
        sendIMessage: createTurnSendIMessageToolFactory(input.messages),
      }),
    ...(input.agentManagement === undefined
      ? {}
      : {
        createAgent: createTurnCreateAgentToolFactory(input.agentManagement),
        updateAgent: createTurnUpdateAgentToolFactory(input.agentManagement),
      }),
    ...(input.state === undefined
      ? {}
      : { updateState: createTurnStateToolFactory(input.state) }),
    ...(input.subagentManagement === undefined
      ? {}
      : {
        subagentManagement: createTurnSubagentManagementToolFactory(
          input.subagentManagement,
        ),
      }),
    ...(input.mcpManagement === undefined
      ? {}
      : {
        mcpManagement: createTurnMcpManagementToolFactory(input.mcpManagement),
      }),
    ...(input.cloudAgent === undefined
      ? {}
      : { cloudAgent: createTurnCloudAgentToolFactory(input.cloudAgent) }),
  };
}

export function createTurnToolsetFactoriesForTurn(
  provider: TurnToolsetHostFactoryProvider,
  turn: TurnToolsetTurnInput,
  props: TurnToolsetBuildProps,
): ReturnType<typeof createTurnToolsetFactories> {
  const externalShell = provider.createExternalShellToolInputs?.(turn, props);
  const externalRead = provider.createExternalReadToolInputs?.(turn, props);
  const boxShell = provider.createBoxShellToolInputs?.(turn, props);
  const boxRead = provider.createBoxReadToolInputs?.(turn, props);
  return createTurnToolsetFactories({
    ...(provider.createTaskToolInputs === undefined
      ? {}
      : { task: provider.createTaskToolInputs(turn, props) }),
    ...(provider.createMultitaskToolInputs === undefined
      ? {}
      : { multitask: provider.createMultitaskToolInputs(turn, props) }),
    ...(provider.createMcpMetaToolInputs === undefined
      ? {}
      : { mcpMeta: provider.createMcpMetaToolInputs(turn, props) }),
    ...(provider.createComputerToolInputs === undefined
      ? {}
      : { computer: provider.createComputerToolInputs(turn, props) }),
    ...(provider.createBrowserToolInputs === undefined
      ? {}
      : { browser: provider.createBrowserToolInputs(turn, props) }),
    ...(provider.createScreenshotToolInputs === undefined
      ? {}
      : { screenshot: provider.createScreenshotToolInputs(turn, props) }),
    ...(provider.createFileTransferToolInputs === undefined
      ? {}
      : { fileTransfer: provider.createFileTransferToolInputs(turn, props) }),
    ...(provider.createRequestBoxHelpToolInputs === undefined
      ? {}
      : { requestBoxHelp: provider.createRequestBoxHelpToolInputs(turn, props) }),
    ...(provider.createGenerateImageToolInputs === undefined
      ? {}
      : { generateImage: provider.createGenerateImageToolInputs(turn, props) }),
    ...(provider.createWebSearchToolInputs === undefined
      ? {}
      : { webSearch: provider.createWebSearchToolInputs(turn, props) }),
    ...(provider.createWebFetchToolInputs === undefined
      ? {}
      : { webFetch: provider.createWebFetchToolInputs(turn, props) }),
    ...(provider.createExternalAwaitToolInputs === undefined
      ? {}
      : { externalAwait: provider.createExternalAwaitToolInputs(turn, props) }),
    ...(provider.createBoxAwaitToolInputs === undefined
      ? {}
      : { boxAwait: provider.createBoxAwaitToolInputs(turn, props) }),
    ...(provider.createExternalShellToolInputs === undefined
      ? {}
      : externalShell === undefined ? {} : { externalShell }),
    ...(provider.createExternalReadToolInputs === undefined
      ? {}
      : externalRead === undefined ? {} : { externalRead }),
    ...(provider.createBoxShellToolInputs === undefined
      ? {}
      : boxShell === undefined ? {} : { boxShell }),
    ...(provider.createBoxReadToolInputs === undefined
      ? {}
      : boxRead === undefined ? {} : { boxRead }),
    ...(provider.createSendMessageToolInputs === undefined
      ? {}
      : { sendMessage: provider.createSendMessageToolInputs(turn, props) }),
    ...(provider.createSendToAgentToolInputs === undefined
      ? {}
      : { sendToAgent: provider.createSendToAgentToolInputs(turn, props) }),
    ...(provider.createReactionToolInputs === undefined
      ? {}
      : { reaction: provider.createReactionToolInputs(turn, props) }),
    ...(provider.createMessagesToolInputs === undefined
      ? {}
      : { messages: provider.createMessagesToolInputs(turn, props) }),
    ...(provider.createAgentManagementToolInputs === undefined
      ? {}
      : { agentManagement: provider.createAgentManagementToolInputs(turn, props) }),
    ...(provider.createStateToolInputs === undefined
      ? {}
      : { state: provider.createStateToolInputs(turn, props) }),
    ...(provider.createSubagentManagementToolInputs === undefined
      ? {}
      : {
        subagentManagement: provider.createSubagentManagementToolInputs(
          turn,
          props,
        ),
      }),
    ...(provider.createMcpManagementToolInputs === undefined
      ? {}
      : {
        mcpManagement: provider.createMcpManagementToolInputs(turn, props),
      }),
    ...(provider.createCloudAgentToolInputs === undefined
      ? {}
      : {
        cloudAgent: provider.createCloudAgentToolInputs(turn, props),
      }),
  });
}

export interface TurnToolsetHost {
  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly isBoxScopedSubagent: boolean;
  readonly isComputerUseSubagent: boolean;
  readonly isBrowserUseSubagent: boolean;
  readonly isSystemPromptOverridden: boolean;
  readonly remoteBoxHasDesktop: boolean;
  readonly localToolPermission?: LocalToolPermission;
  getConversationId(): string;
  getRemoteBoxAvailable(): boolean;
  cloudAgentsDisabledByTeam(): boolean;
  spotlightEnabled(): boolean;
  isDynamicToolsEnabled?(): boolean;
  isMultitaskEnabled?(): boolean;
  isSharedRoomBoxToolsEnabled?(): boolean;
  recordModelToolName?(toolCallId: string, name: string): void;
  toolExecutionTimeoutMs?(toolName: string): number;
  /**
   * Base per-turn provider.  It is projected with runtime props only by the
   * lazy toolsGenerator boundary; keeping it here avoids requiring a
   * ConversationStateHandle during Agent construction.
   */
  factoryProvider?: TurnToolsetHostFactoryProvider;
  factories: TurnToolFactories;
}

export type TurnToolsetInput = TurnToolsetTurnInput;

export function extractSandAutoReviewClassifierContext(
  messages: readonly { readonly role: string; readonly content: string }[],
): readonly { readonly role: string; readonly content: string }[] {
  return messages.filter((message) => {
    if (message.role !== "user") return true;
    if (
      message.content.startsWith(
        `${SAND_HIDDEN_PROMPT_MARKER}${SAND_TRUSTED_AUTOMATION_PROMPT_MARKER}`,
      )
    ) return true;
    return !message.content.startsWith(SAND_HIDDEN_PROMPT_MARKER);
  });
}

export function buildTurnTools(
  host: TurnToolsetHost,
  turn: TurnToolsetInput,
  props?: TurnToolsetBuildProps,
): ToolSetHandle {
  if (
    host.isSubagentRunner
    && (host.isComputerUseSubagent || host.isBrowserUseSubagent) === false
    && turn.subagentConfigs === undefined
  ) {
    return fencedToolSet([], host.spotlightEnabled());
  }

  const dynamicToolsEnabled =
    !host.isSubagentRunner
    && !host.isSharedRoomRunner
    && !host.isBoxScopedSubagent
    && host.isDynamicToolsEnabled?.() === true;
  const dynamicToolRegistry = dynamicToolsEnabled
    ? new DynamicToolRegistry()
    : undefined;
  const dynamicInvocationRegistry = dynamicToolRegistry === undefined
    ? undefined
    : {
      resolveToolName(rawArguments: string): string | undefined {
        return resolveDynamicDispatchToolName(rawArguments, dynamicToolRegistry);
      },
    };
  const tools: TurnTool[] = [];
  const factories = host.factories;

  if (
    !host.isSubagentRunner
    && !host.isSharedRoomRunner
    && turn.subagentConfigs != null
  ) {
    const tool = props === undefined
      ? factories.task?.()
      : createTurnTaskToolFactory({
        resourceAccessor: props.resourceAccessor as TaskToolParameters[0],
        getTaskToolConfig: async () => ({
          agentConfig: {
            ...props.config,
            toolsGenerator: () => fencedToolSet([], host.spotlightEnabled()),
          },
          promptSession: props.toolSession,
          summarizationHandler: props.summarizationHandler,
        }),
        parentModelInfo: props.parentModelInfo as TaskToolParameters[2],
        stateHandler: props.stateHandler as unknown as TaskToolParameters[3],
        subagentConfigs: turn.subagentConfigs,
        options: {
          readonlyShellEnabled: false,
          allowCustomModelId: false,
          includeExploreSubagent: false,
          subagentModels: props.subagentModels,
          requireServerSideSubagent: false,
          compareModelCosts: () => 0,
          isModelBlocked: () => false,
          isModelValid: () => true,
          useClientSideSubagent: true,
          enableExploreParentModelInheritance: true,
          enableJobCompletionNotifications: true,
          geminiVideoAttachedMediaUrlProvider: turn.geminiVideoAttachedMediaUrlProvider,
          enableAgentChatLinks: false,
          trustedVideoAttachmentRoots: host.remoteBoxHasDesktop
            ? [SAND_BOX_WORKSPACE_ROOT]
            : [],
        } as unknown as TaskToolParameters[5],
      })();
    if (tool !== undefined) tools.push(tool);
  }
  if (
    !host.isSubagentRunner
    && !host.isSystemPromptOverridden
    && host.isMultitaskEnabled?.() === true
  ) {
    const tool = factories.multitask?.();
    if (tool !== undefined) tools.push(tool);
  }
  if (!host.isSubagentRunner) {
    const sendMessage = factories.sendMessage?.();
    if (sendMessage !== undefined) tools.push(sendMessage);
    const sendToAgent = factories.sendToAgent?.();
    if (sendToAgent !== undefined) tools.push(sendToAgent);
    const reaction = factories.reaction?.();
    if (reaction !== undefined) tools.push(reaction);
    const createAgent = factories.createAgent?.();
    if (createAgent !== undefined) tools.push(createAgent);
    const updateAgent = factories.updateAgent?.();
    if (updateAgent !== undefined) tools.push(updateAgent);
    if (!host.isSystemPromptOverridden) {
      const updateState = factories.updateState?.();
      if (updateState !== undefined) tools.push(updateState);
    }
  }

  const agentId = host.getConversationId();
  const scoped = (
    tool: TurnTool | undefined,
    action?: SandLocalToolAction,
  ): TurnTool | undefined => tool == null
    ? undefined
    : withLocalToolScope(
      withRecordedToolCallNames(
        tool,
        (toolCallId, name) =>
          host.recordModelToolName?.(toolCallId, name),
      ),
      agentId,
      host.localToolPermission,
      action,
    );

  if (!host.isBoxScopedSubagent) {
    const externalShell = scoped(factories.externalShell?.(), "run-command");
    if (externalShell !== undefined) tools.push(externalShell);
    const externalRead = scoped(factories.externalRead?.(), "read-file");
    if (externalRead !== undefined) tools.push(externalRead);
    const externalAwait = scoped(factories.externalAwait?.(), "read-file");
    if (externalAwait !== undefined) tools.push(externalAwait);
    // Reading a conversation and sending as the user are scoped separately, so
    // an approval for one never covers the other.
    const readMessages = scoped(factories.readMessages?.(), "read-messages");
    if (readMessages !== undefined) tools.push(readMessages);
    const sendIMessage = scoped(factories.sendIMessage?.(), "send-imessage");
    if (sendIMessage !== undefined) tools.push(sendIMessage);
    const webSearch = factories.webSearch?.();
    if (webSearch !== undefined) tools.push(webSearch);
    const webFetch = factories.webFetch?.();
    if (webFetch !== undefined) tools.push(webFetch);
  }

  if (!host.isSubagentRunner) {
    const generateImage = factories.generateImage?.();
    if (generateImage !== undefined) tools.push(generateImage);
  }

  if (
    !host.isBoxScopedSubagent
    && !host.cloudAgentsDisabledByTeam()
  ) {
    const cloudAgent = factories.cloudAgent?.();
    if (cloudAgent !== undefined) tools.push(cloudAgent);
  }

  if (host.getRemoteBoxAvailable()) {
    const boxShell = scoped(factories.boxShell?.());
    if (boxShell !== undefined) tools.push(boxShell);
    const boxRead = scoped(factories.boxRead?.());
    if (boxRead !== undefined) tools.push(boxRead);
    if (!host.isBoxScopedSubagent) {
      const boxAwait = scoped(factories.boxAwait?.());
      if (boxAwait !== undefined) tools.push(boxAwait);
      const fileTransfer = factories.fileTransfer?.();
      if (fileTransfer !== undefined) tools.push(...fileTransfer.map((tool) => withLocalToolScope(tool, agentId, host.localToolPermission)));
    }
  }

  if (
    host.isComputerUseSubagent
    && host.remoteBoxHasDesktop
    && host.getRemoteBoxAvailable()
  ) {
    const computer = factories.computer?.();
    if (computer !== undefined) tools.push(computer);
  }
  if (
    host.isBrowserUseSubagent
    && host.remoteBoxHasDesktop
    && host.getRemoteBoxAvailable()
  ) {
    const browser = factories.browser?.();
    if (browser !== undefined) tools.push(...browser);
  }
  if (
    !host.isSubagentRunner
    && host.remoteBoxHasDesktop
    && host.getRemoteBoxAvailable()
  ) {
    const screenshot = factories.screenshot?.();
    if (screenshot !== undefined) tools.push(screenshot);
    const requestBoxHelp = factories.requestBoxHelp?.();
    if (requestBoxHelp !== undefined) tools.push(requestBoxHelp);
  }

  // The immutable builder only offers the MCP discovery/call pair when the
  // live per-turn MCP projection exists, or dynamic mode owns the registry.
  // A supplied factory alone is not an MCP service and must remain dormant.
  if (
    !host.isBoxScopedSubagent
    && (props?.mcp !== undefined || dynamicToolRegistry !== undefined)
  ) {
    const mcpMeta = factories.mcpMeta?.(dynamicToolRegistry);
    if (mcpMeta !== undefined) tools.push(...mcpMeta);
  }
  if (!host.isSubagentRunner) {
    const mcpManagement = factories.mcpManagement?.();
    if (mcpManagement !== undefined) tools.push(...mcpManagement);
    if (turn.subagentConfigs != null) {
      const subagentManagement = factories.subagentManagement?.()
        ?? (props?.hostDependencies?.subagentManagement === undefined
          ? undefined
          : createTurnSubagentManagementToolFactory({
            controller: props.hostDependencies.subagentManagement,
          })());
      if (subagentManagement !== undefined) tools.push(...subagentManagement);
    }
  }

  const sharedRoomAllowed = host.isSharedRoomRunner
    ? host.isSharedRoomBoxToolsEnabled?.() === false
      ? SHARED_ROOM_TEXT_ONLY_TOOL_NAMES
      : SHARED_ROOM_TOOL_NAMES
    : undefined;
  const offered = sharedRoomAllowed == null
    ? tools
    : tools.filter((tool) => sharedRoomAllowed.has(tool.name));

  const placed = dynamicToolsEnabled
    ? offered.map(withDynamicToolPlacement)
    : offered;
  const guarded = placed.map((tool) => {
    if (
      dynamicInvocationRegistry !== undefined
      && tool.dynamicToolMetaRole === "invocation"
    ) {
      return wrapDynamicInvocationToolWithTimeout(
        tool as StreamingTurnTool,
        dynamicInvocationRegistry,
        host.isComputerUseSubagent,
      ) as unknown as TurnTool;
    }
    const executionTimeoutMs = sandToolCallExecutionTimeoutMs(
      tool.name,
      host.isComputerUseSubagent,
    );
    return withToolTimeout(tool, executionTimeoutMs, () =>
      createToolCallExecutionTimeoutError({
        toolName: tool.name,
        executionTimeoutMs,
      }));
  });

  return fencedToolSet(guarded, host.spotlightEnabled(), dynamicToolRegistry);
}
