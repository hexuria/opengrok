import type { Context } from "../../../../context/core.js";
import { Struct, type JsonValue } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createStringResult } from "../../../../chat-inference/prompt-executor.js";
import type { ResourceAccessor } from "../../../../agent-exec/resource-provider.js";
import type { RemoteExecManager, StreamExecutor } from "../../../../agent-exec/remote.js";
import { shellStreamExecutorResource } from "../../../../agent-exec/shell-stream.js";
import { smartModeClassifierExecutorResource } from "../../../../agent-exec/smart-mode-classifier.js";
import { SandboxPolicy_Type, SandboxPolicy } from "../../../../proto/generated/agent/v1/sandbox_pb.js";
import {
  ShellAbortReason,
  ShellArgs,
  ShellBackgroundReason,
  ShellCommandParsingResult,
  ShellCommandParsingResult_ExecutableCommand,
  ShellCommandParsingResult_ExecutableCommandArg,
  ShellCommandParsingResult_Redirect,
  ShellFailure,
  ShellPermissionDenied,
  ShellRejected,
  ShellResult,
  ShellSandboxUnsupported,
  ShellSpawnError,
  ShellStream,
  ShellSuccess,
  ShellTimeout,
  TimeoutBehavior,
} from "../../../../proto/generated/agent/v1/shell_exec_pb.js";
import { SmartModeClassifierArgs, SmartModeClassifierDecision, SmartModeRiskTarget, type SmartModeClassifierConversationMessage } from "../../../../proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";
import type { RequestContext } from "../../../../proto/generated/agent/v1/request_context_exec_pb.js";
import { ShellToolCall } from "../../../../proto/generated/agent/v1/shell_tool_pb.js";
import { ToolCall } from "../../../../proto/generated/agent/v1/agent_pb.js";
import type { HookAdditionalContext } from "../../../../proto/generated/agent/v1/hook_additional_context_pb.js";
import { analyzeShellCommand, type ShellCommandAnalysis } from "../../../../shell-exec/shell-parser.js";
import {
  CustomToolCallError,
  ToolCallAbortedError,
  ToolCallRejectedError,
  ToolCallUnexpectedEnvironmentError,
  ToolTimeoutError,
  createZodAgentTool,
  withSafeParsedArgs,
} from "../../common.js";
import { ToolErrorClassification } from "../../core.js";
import { getDescriptionDsv3, getParametersSchemaDsv3 } from "./prompts/dsv3.js";
import { formatShellResult, renderShellResultToString } from "./formatters.js";
import { BACKGROUND_SHELL_DEFAULT_BLOCK_UNTIL_MS } from "../../tool-execution-timeout.js";
import { getConversationId } from "../../../utils/request-id.js";
import { AgentType } from "../../../utils/agent-config.js";
import { loadSmartModeProjectPermissionsContext } from "../../../smart-mode-project-permissions.js";
import { tryExtractSmartModeClassifierConversationContext } from "../../../smart-mode-classifier-context.js";
import { executeSmartModeClassifierWithMeasurement } from "../../../utils/smart-mode-classifier-measurement.js";
import { delayDevSmartModeClassifierIfRequested, type OneShotState } from "../../dev-smart-mode-classifier-block.js";
import { withToolExecutionTimeoutSuspended } from "../../tool-timeout-suspension.js";
import type { ConversationStateHandle } from "../../../state.js";
import { checkModelFacingShellUiAutomation } from "./model-facing-ui-automation-guard.js";
import { failOpenIsolatedBoxClassifierError, isSandTeachSessionShellCommand } from "./teach-session-auto-review.js";

/** The resource boundary owned by the shell executor lane (B1). */
export type ShellToolResourceAccessor = ResourceAccessor<RemoteExecManager>;
export type ShellStreamExecutor = StreamExecutor<ShellArgs, ShellStream>;

export type ShellToolSurface = "host_machine" | "isolated_box";

export interface ShellExecutionPlan {
  readonly shouldStartInBackground: boolean;
  readonly backgroundAfterMs: number;
  readonly hardTimeoutMs?: number;
  readonly timeoutBehavior: TimeoutBehavior;
}

export interface ShellPreflightRequest {
  readonly command: string;
  readonly workingDirectory?: string;
  readonly isBackground: boolean;
  readonly analysis: ShellCommandAnalysis;
  readonly executionPlan: ShellExecutionPlan;
  readonly requestedSandboxPolicy?: SandboxPolicy;
  readonly surface: ShellToolSurface;
}

export type ShellPreflightDecision =
  | { readonly allow: true; readonly auditId?: string }
  | { readonly allow: false; readonly reason: string; readonly auditId?: string };

export interface ShellToolInteractionHandler {
  executeToolCall(
    ctx: Context,
    toolCall: ToolCall,
    toolCallId: string,
    execute: (ctx: Context) => Promise<ShellResult>,
    merge: (result: ShellResult) => ToolCall,
    hookContextCollector?: unknown,
  ): Promise<ShellResult>;
  getAbortSignal(ctx: Context): AbortSignal;
  emitPartialToolCall?(ctx: Context, toolCallId: string, toolCall: ToolCall): Promise<void>;
}

export interface ShellToolExecutionMeta {
  readonly toolCallId: string;
  readonly execId?: string;
  readonly hookContextCollector?: HookAdditionalContext[];
  readonly strictArgParsing?: boolean;
  readonly workspacePaths?: readonly string[];
  readonly stateHandler?: { readonly isDsv3?: () => boolean };
  readonly userAutoRunInstructions?: ShellAutoRunInstructions;
  readonly projectAutoRunInstructions?: ShellAutoRunInstructions;
}

function isConversationStateHandle(value: { readonly isDsv3?: () => boolean }): value is ConversationStateHandle {
  return "conversationStateStructure" in value && "readPaths" in value;
}

export interface ShellAutoRunInstructions {
  readonly allowInstructions: readonly string[];
  readonly blockInstructions: readonly string[];
}

export interface ShellSmartModeApprovalTarget {
  readonly surface: string;
  readonly command: string;
  readonly workingDirectory?: string;
  readonly requestedSandboxPolicy?: SandboxPolicy;
  readonly isBackground: boolean;
  readonly isReadonly: boolean;
  readonly executionPlan: ShellExecutionPlan;
  readonly executionStateIdentity?: string;
  readonly targetEnrichmentHash?: string;
  readonly blockReason: string;
  readonly description?: string;
  readonly proposedAllowRule?: string;
}

export interface ShellSmartModeApprovalProvider {
  requestApproval(input: {
    readonly kind: "shell";
    readonly target: ShellSmartModeApprovalTarget;
    readonly fingerprint: string;
    readonly toolCallId: string;
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal;
  }): Promise<{ readonly approved: boolean; readonly reason?: string | undefined }>;
}

export interface ShellSmartModeApprovalState {
  getIdentity(): string | undefined;
  markSideEffectStart(): void;
}

export interface ShellToolOptions {
  readonly surface?: ShellToolSurface;
  readonly toolName?: string;
  readonly toolIdentifier?: string;
  readonly promptVersion?: string;
  readonly shellType?: string;
  readonly sandboxEnabled?: boolean;
  readonly sandboxPromptEnabled?: boolean;
  readonly isReadonly?: boolean;
  readonly enableBlockUntilMs?: boolean;
  readonly requireBlockUntilMs?: boolean;
  readonly defaultBlockUntilMs?: number;
  readonly defaultTimeoutMs?: number;
  readonly hardTimeoutMs?: number;
  readonly terminalsFolder?: string;
  readonly useMinimalHarness?: boolean;
  readonly agentType?: string;
  readonly parametersSchema?: ReturnType<typeof getParametersSchemaDsv3>;
  readonly adminCommandDenylist?: readonly string[];
  readonly fileOperationLockManager?: {
    waitForExclusiveLock(ctx: Context): Promise<{ [Symbol.dispose](): void }>;
  };
  readonly preflight?: (ctx: Context, request: ShellPreflightRequest) => Promise<ShellPreflightDecision>;
  readonly onAudit?: (ctx: Context, request: ShellPreflightRequest, decision: ShellPreflightDecision) => void;
  readonly onStreamEvent?: (ctx: Context, event: ShellStream) => Promise<void>;
  readonly onTelemetry?: (ctx: Context, event: { readonly type: "started" | "finished" | "backgrounded"; readonly toolCallId: string }) => void;
  readonly isPlatformEnabled?: (platform: NodeJS.Platform) => boolean;
  readonly requestContext?: Pick<RequestContext, "env">;
  readonly smartModeClassifierMode?: boolean;
  readonly smartModeClassifierShadowMode?: boolean;
  readonly smartModeApprovalSurface?: string;
  readonly smartModeApprovalProvider?: ShellSmartModeApprovalProvider;
  readonly smartModeShellTargetEnrichmentProvider?: (
    ctx: Context,
    args: { readonly resourceAccessor: ShellToolResourceAccessor; readonly command: string; readonly workingDirectory?: string; readonly toolCallId: string },
  ) => Promise<unknown>;
  readonly smartModeShellApprovalState?: ShellSmartModeApprovalState;
  readonly extractSmartModeClassifierConversationContext?: (ctx: Context, state: ConversationStateHandle) => Promise<readonly SmartModeClassifierConversationMessage[]>;
  readonly userAutoRunInstructions?: ShellAutoRunInstructions;
  readonly projectAutoRunInstructions?: ShellAutoRunInstructions;
  readonly smartModeClassifierMaxAttempts?: number;
  readonly suppressSmartModeClassifierTelemetryIds?: boolean;
  readonly devSmartModeClassifierBlockState?: OneShotState;
  readonly devSmartModeClassifierDelayState?: OneShotState;
  readonly disableSmartModeAllowlistPrecheck?: boolean;
  readonly loadSmartModeWorkspacePermissionFiles?: boolean;
  readonly enforceModelFacingShellUiAutomationGuard?: boolean;
  readonly readToolIdentifier?: string;
  readonly awaitToolIdentifier?: string;
  readonly enableJobCompletionNotifications?: boolean;
  readonly enableTerminalFiles?: boolean;
}

export class ShellToolRejectedError extends ToolCallRejectedError {
  constructor(readonly command: string, readonly workingDirectory: string | undefined, readonly reason: string) { super(reason); }
}

export class ShellToolPermissionDeniedError extends CustomToolCallError {
  constructor(readonly command: string, readonly workingDirectory: string | undefined, readonly error: string, readonly isReadonly: boolean) {
    super(ToolErrorClassification.USER_REJECTED, {
      error: `Permission denied: ${error}`,
      clientVisibleErrorMessage: isReadonly ? "You are in ask mode and cannot run non read-only tools. Ask the user to switch to agent mode if edits are required." : `Permission denied: ${error}`,
      modelVisibleErrorMessage: isReadonly ? "You are in ask mode and cannot run non read-only tools. Ask the user to switch to agent mode if edits are required." : `Permission denied: ${error}`,
    });
  }
}

export class ShellToolTimeoutError extends ToolTimeoutError {
  constructor(readonly command: string, readonly workingDirectory: string | undefined, readonly timeoutMs: number) {
    const message = `The shell command did not complete within ${timeoutMs} ms.`;
    super({ error: message, clientVisibleErrorMessage: message, modelVisibleErrorMessage: message });
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HARD_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

function createShellToolCall(value: ShellToolCall): ToolCall {
  return new ToolCall({ tool: { case: "shellToolCall", value } });
}

const REQUEST_SMART_MODE_APPROVAL_DESCRIPTION = "Set to true when immediately retrying the exact same command after Auto-review blocks it and you decide the user should approve it through the native approval card.";
const SMART_MODE_BLOCK_REASON_DESCRIPTION = "Provide the exact block reason returned by Auto-review in the prior rejection. Required when request_smart_mode_approval is true so the approval card shows the original classifier reason without re-running the classifier.";

function addSmartModeApprovalParameters(
  parameters: ReturnType<typeof getParametersSchemaDsv3>,
  enabled: boolean,
): ReturnType<typeof getParametersSchemaDsv3> {
  if (!enabled) return parameters;
  return parameters.extend({
    request_smart_mode_approval: z.boolean().optional().describe(REQUEST_SMART_MODE_APPROVAL_DESCRIPTION),
    smart_mode_block_reason: z.string().optional().describe(SMART_MODE_BLOCK_REASON_DESCRIPTION),
  });
}

function resolvePlan(rawArgs: Record<string, unknown>, options: ShellToolOptions): ShellExecutionPlan {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultBlockUntilMs = options.defaultBlockUntilMs ?? (options.agentType === "background" ? BACKGROUND_SHELL_DEFAULT_BLOCK_UNTIL_MS : defaultTimeoutMs);
  if (options.enableBlockUntilMs === true) {
    const requested = typeof rawArgs.block_until_ms === "number" ? rawArgs.block_until_ms : defaultBlockUntilMs;
    return {
      shouldStartInBackground: rawArgs.is_background === true || requested === 0,
      backgroundAfterMs: Math.min(requested, options.defaultTimeoutMs ?? requested),
      hardTimeoutMs: options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS,
      timeoutBehavior: TimeoutBehavior.BACKGROUND,
    };
  }
  const requestedTimeout = typeof rawArgs.timeout === "number" ? rawArgs.timeout : defaultTimeoutMs;
  return {
    shouldStartInBackground: rawArgs.is_background === true,
    backgroundAfterMs: requestedTimeout,
    ...(options.hardTimeoutMs === undefined ? {} : { hardTimeoutMs: options.hardTimeoutMs }),
    timeoutBehavior: TimeoutBehavior.BACKGROUND,
  };
}

function requestedPolicy(rawArgs: Record<string, unknown>, options: ShellToolOptions, workspacePaths: readonly string[] = []): SandboxPolicy | undefined {
  if (options.sandboxEnabled !== true) return undefined;
  const permissions = Array.isArray(rawArgs.required_permissions) ? rawArgs.required_permissions : [];
  const all = permissions.includes("all");
  const network = permissions.includes("network") || permissions.includes("full_network");
  if (options.isReadonly === true) return new SandboxPolicy({ type: SandboxPolicy_Type.WORKSPACE_READONLY, networkAccess: network });
  if (all) return new SandboxPolicy({ type: SandboxPolicy_Type.INSECURE_NONE });
  return new SandboxPolicy({ type: SandboxPolicy_Type.WORKSPACE_READWRITE, networkAccess: network, additionalReadwritePaths: [...workspacePaths] });
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    const values = value.map(toJsonValue);
    return values.some(entry => entry === undefined) ? undefined : values as JsonValue[];
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const jsonValue = toJsonValue(entry);
      if (jsonValue !== undefined) result[key] = jsonValue;
    }
    return result;
  }
  return undefined;
}

function toJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  const json = toJsonValue(value);
  if (json == null || Array.isArray(json) || typeof json !== "object") return {};
  return json;
}

function shellPolicyFingerprint(policy: SandboxPolicy | undefined): JsonValue | null {
  return policy === undefined ? null : policy.toJson({ emitDefaultValues: true }) as JsonValue;
}

function computeShellApprovalFingerprint(target: ShellSmartModeApprovalTarget): string {
  return createHash("sha256").update(JSON.stringify({
    surface: target.surface,
    command: target.command,
    workingDirectory: target.workingDirectory ?? null,
    requestedSandboxPolicy: shellPolicyFingerprint(target.requestedSandboxPolicy),
    isBackground: target.isBackground,
    isReadonly: target.isReadonly,
    executionPlan: target.executionPlan,
    executionStateIdentity: target.executionStateIdentity ?? null,
    targetEnrichmentHash: target.targetEnrichmentHash ?? null,
  })).digest("hex");
}

function buildClassifierEscalatedSandboxPolicy(
  requestedSandboxPolicy: SandboxPolicy | undefined,
): SandboxPolicy {
  return new SandboxPolicy({
    type: SandboxPolicy_Type.INSECURE_NONE,
    ...(requestedSandboxPolicy?.enableSharedBuildCache === undefined ? {} : { enableSharedBuildCache: requestedSandboxPolicy.enableSharedBuildCache }),
  });
}

function hasUnavailableApprovalBinding(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (!("approval_binding_unavailable" in value)) return false;
  return value.approval_binding_unavailable === true;
}

function hashTargetEnrichment(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : createHash("sha256").update(serialized).digest("hex");
}

type ShellSmartModeDecision =
  | { readonly kind: "allow"; readonly enabled: boolean; readonly targetEnrichmentHash?: string }
  | { readonly kind: "block"; readonly reason: string; readonly proposedAllowRule?: string; readonly targetEnrichmentHash?: string }
  | { readonly kind: "reject"; readonly reason: string };

const SMART_MODE_SHELL_BLOCK_REASON = "Blocked by Auto-review";
const SMART_MODE_SHELL_CLASSIFIER_ERROR_REASON = "An error occured while classifying this action. Please review manually.";

async function runShellSmartModeClassifier(
  ctx: Context,
  resourceAccessor: ShellToolResourceAccessor,
  options: ShellToolOptions,
  rawArgs: Record<string, unknown>,
  meta: ShellToolExecutionMeta,
  command: string,
  workingDirectory: string | undefined,
  description: string | undefined,
  executionPlan: ShellExecutionPlan,
  requestedSandboxPolicy: SandboxPolicy | undefined,
  surface: ShellToolSurface,
  signal: AbortSignal,
): Promise<ShellSmartModeDecision> {
  const isBackgroundAgent = options.agentType === AgentType.BACKGROUND || options.agentType === "background";
  const autoModeSelected = options.smartModeClassifierMode === true && options.requestContext?.env?.smartModeClassifierAutoModeEnabled === true;
  const enabled = !isBackgroundAgent && autoModeSelected;
  const shadowEnabled = !isBackgroundAgent && !enabled && options.smartModeClassifierShadowMode === true;
  if (surface === "isolated_box" && isSandTeachSessionShellCommand(command, workingDirectory)) {
    return { kind: "allow", enabled: true };
  }
  if (!enabled && !shadowEnabled) return { kind: "allow", enabled: false };

  const consumedDevBlock = enabled && options.devSmartModeClassifierBlockState?.consume() === true;
  if (consumedDevBlock) {
    await delayDevSmartModeClassifierIfRequested(options.devSmartModeClassifierDelayState);
    return { kind: "block", reason: "This is a dev block whatever just retry it" };
  }

  const targetEnrichment = await options.smartModeShellTargetEnrichmentProvider?.(ctx, {
    resourceAccessor,
    command,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    toolCallId: meta.toolCallId,
  });
  if (options.smartModeApprovalProvider !== undefined && hasUnavailableApprovalBinding(targetEnrichment)) {
    throw new ShellToolRejectedError(command, workingDirectory, "The executable content could not be bound to this review. Run the resolved script directly or provide an explicit working directory.");
  }
  const targetEnrichmentHash = hashTargetEnrichment(targetEnrichment);
  const conversationContext: SmartModeClassifierConversationMessage[] = meta.stateHandler === undefined || !isConversationStateHandle(meta.stateHandler)
    ? []
    : options.extractSmartModeClassifierConversationContext === undefined
      ? await tryExtractSmartModeClassifierConversationContext(ctx, meta.stateHandler)
      : [...await options.extractSmartModeClassifierConversationContext(ctx, meta.stateHandler)];
  const workspacePaths = options.loadSmartModeWorkspacePermissionFiles === false ? undefined : meta.workspacePaths;
  const projectPermissions = await loadSmartModeProjectPermissionsContext(
    ctx,
    workspacePaths,
    meta.userAutoRunInstructions ?? options.userAutoRunInstructions,
    meta.projectAutoRunInstructions ?? options.projectAutoRunInstructions,
  );
  const target = new SmartModeRiskTarget({
    action: "shell",
    arguments: Struct.fromJson(toJsonRecord({
      command,
      ...(workingDirectory === undefined ? {} : { working_directory: workingDirectory }),
      surface,
      description,
      background: { start_in_background: executionPlan.shouldStartInBackground },
      timeout: {
        background_after_ms: executionPlan.backgroundAfterMs,
        hard_timeout_ms: executionPlan.hardTimeoutMs,
        timeout_behavior: executionPlan.timeoutBehavior,
      },
      sandbox_enabled: options.sandboxEnabled === true,
      is_readonly: options.isReadonly === true,
      requested_sandbox_policy: shellPolicyFingerprint(requestedSandboxPolicy),
      project_permissions: projectPermissions,
      target_enrichment: targetEnrichment,
    })),
  });

  const run = async (mode: "enforce" | "shadow"): Promise<ShellSmartModeDecision> => {
    const executor = resourceAccessor.get(smartModeClassifierExecutorResource);
    await delayDevSmartModeClassifierIfRequested(options.devSmartModeClassifierDelayState);
    const parentConversationId = getConversationId(ctx);
    const result = await executeSmartModeClassifierWithMeasurement(
      ctx,
      executor,
      new SmartModeClassifierArgs({
        toolCallId: meta.toolCallId,
        ...(parentConversationId === undefined ? {} : { parentConversationId }),
        target,
        conversationContext,
      }),
      mode,
      workspacePaths,
      {
        suppressToolCallIdLogging: options.suppressSmartModeClassifierTelemetryIds === true,
        maxAttempts: options.smartModeClassifierMaxAttempts,
      },
    );
    if (result.result.case === "success" && result.result.value.decision === SmartModeClassifierDecision.BLOCK) {
      return {
        kind: "block",
        reason: result.result.value.blockReason ?? SMART_MODE_SHELL_BLOCK_REASON,
        ...(result.result.value.proposedAllowRule === undefined ? {} : { proposedAllowRule: result.result.value.proposedAllowRule }),
        ...(targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash }),
      };
    }
    if (result.result.case === "success" && result.result.value.decision === SmartModeClassifierDecision.ALLOW) {
      return { kind: "allow", enabled: mode === "enforce", ...(targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash }) };
    }
    if (failOpenIsolatedBoxClassifierError(surface)) {
      return { kind: "allow", enabled: true, ...(targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash }) };
    }
    return { kind: "reject", reason: SMART_MODE_SHELL_CLASSIFIER_ERROR_REASON };
  };

  if (!enabled) {
    void run("shadow").catch(() => undefined);
    return { kind: "allow", enabled: false, ...(targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash }) };
  }
  try {
    return await run("enforce");
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof ShellToolRejectedError) throw error;
    if (signal.aborted) throw new ToolCallAbortedError();
    if (failOpenIsolatedBoxClassifierError(surface)) {
      return { kind: "allow", enabled: true, ...(targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash }) };
    }
    return { kind: "reject", reason: SMART_MODE_SHELL_CLASSIFIER_ERROR_REASON };
  }
}

function shellArgs(rawArgs: Record<string, unknown>, analysis: ShellCommandAnalysis, plan: ShellExecutionPlan, options: ShellToolOptions, meta: ShellToolExecutionMeta, policy: SandboxPolicy | undefined, skipApproval = false): ShellArgs {
  const command = String(rawArgs.command);
  const workingDirectory = typeof rawArgs.working_directory === "string" ? rawArgs.working_directory : "";
  const description = typeof rawArgs.description === "string" ? rawArgs.description : typeof rawArgs.explanation === "string" ? rawArgs.explanation : undefined;
  return new ShellArgs({
    command,
    workingDirectory,
    timeout: plan.backgroundAfterMs,
    toolCallId: meta.toolCallId,
    simpleCommands: [...analysis.legacy.simpleCommands],
    hasInputRedirect: analysis.legacy.hasInputRedirect,
    hasOutputRedirect: analysis.legacy.hasOutputRedirect,
    parsingResult: new ShellCommandParsingResult({
      parsingFailed: analysis.structured.parsingFailed,
      hasRedirects: analysis.structured.hasRedirects,
      hasCommandSubstitution: analysis.structured.hasCommandSubstitution,
      ...(analysis.structured.allRedirectsAreDevNull === undefined ? {} : { allRedirectsAreDevNull: analysis.structured.allRedirectsAreDevNull }),
      executableCommands: analysis.structured.executableCommands.map(commandValue => new ShellCommandParsingResult_ExecutableCommand({
        name: commandValue.name,
        fullText: commandValue.fullText,
        args: commandValue.args.map(argument => new ShellCommandParsingResult_ExecutableCommandArg({ type: argument.type, value: argument.value })),
      })),
      redirects: analysis.structured.redirects.map(redirect => new ShellCommandParsingResult_Redirect({
        operator: redirect.operator,
        destinationFds: [...redirect.destinationFds],
        targetNodeType: redirect.targetNodeType,
        ...(redirect.targetText === undefined ? {} : { targetText: redirect.targetText }),
      })),
    }),
    ...(policy === undefined ? {} : { requestedSandboxPolicy: policy }),
    isBackground: plan.shouldStartInBackground,
    skipApproval,
    timeoutBehavior: plan.timeoutBehavior,
    ...(plan.hardTimeoutMs === undefined ? {} : { hardTimeout: plan.hardTimeoutMs }),
    ...(description === undefined ? {} : { description }),
    closeStdin: false,
    adminCommandDenylist: [...(options.adminCommandDenylist ?? [])],
  });
}

function makeResultFromStream(command: string, workingDirectory: string, stdout: string, stderr: string, interleavedOutput: string, exit: Extract<ShellStream["event"], { case: "exit" }> | undefined, policy: SandboxPolicy | undefined): ShellResult {
  if (exit === undefined) throw new Error("Shell exec stream closed without an exit event; result is unknown");
  const value = exit.value;
  const success = value.code === 0 && !value.aborted;
  const base = { command, workingDirectory, exitCode: value.code, signal: value.aborted ? "SIGTERM" : "", stdout, stderr, executionTime: value.localExecutionTimeMs ?? 0, interleavedOutput, ...(value.outputLocation === undefined ? {} : { outputLocation: value.outputLocation }), ...(value.abortReason === undefined ? {} : { abortReason: value.abortReason }), ...(value.aborted ? { aborted: true } : {}) };
  return new ShellResult({ result: success ? { case: "success", value: new ShellSuccess(base) } : { case: "failure", value: new ShellFailure(base) }, ...(policy === undefined ? {} : { sandboxPolicy: policy }) });
}

async function executeStream(ctx: Context, executor: ShellStreamExecutor, args: ShellArgs, interaction: ShellToolInteractionHandler, meta: ShellToolExecutionMeta, options: ShellToolOptions, policy: SandboxPolicy | undefined): Promise<ShellResult> {
  let stdout = "";
  let stderr = "";
  let interleavedOutput = "";
  let exit: Extract<ShellStream["event"], { case: "exit" }> | undefined;
  const executorOptions = {
    ...(meta.execId === undefined ? {} : { execId: meta.execId }),
    ...(meta.hookContextCollector === undefined ? {} : { hookContextCollector: meta.hookContextCollector }),
  };
  for await (const event of executor.execute(ctx, args, executorOptions)) {
    await options.onStreamEvent?.(ctx, event);
    switch (event.event.case) {
      case "stdout": stdout += event.event.value.data; interleavedOutput += event.event.value.data; break;
      case "stderr": stderr += event.event.value.data; interleavedOutput += event.event.value.data; break;
      case "exit": exit = event.event; break;
      case "rejected": throw new ShellToolRejectedError(event.event.value.command, event.event.value.workingDirectory, event.event.value.reason);
      case "permissionDenied": throw new ShellToolPermissionDeniedError(event.event.value.command, event.event.value.workingDirectory, event.event.value.error, event.event.value.isReadonly);
      case "sandboxUnsupported": throw new ToolCallUnexpectedEnvironmentError(event.event.value.reason);
      case "backgrounded": {
        options.onTelemetry?.(ctx, { type: "backgrounded", toolCallId: meta.toolCallId });
        return new ShellResult({ result: { case: "success", value: new ShellSuccess({ command: event.event.value.command, workingDirectory: event.event.value.workingDirectory, shellId: event.event.value.shellId, ...(event.event.value.pid === undefined ? {} : { pid: event.event.value.pid }), ...(event.event.value.msToWait === undefined ? {} : { msToWait: event.event.value.msToWait }), ...(event.event.value.reason === undefined ? {} : { backgroundReason: event.event.value.reason }), stdout, stderr, interleavedOutput, executionTime: 0 }) }, isBackground: true, ...(policy === undefined ? {} : { sandboxPolicy: policy }) });
      }
      case "start": break;
      case "hookContext": break;
      case undefined: break;
    }
  }
  return makeResultFromStream(args.command, args.workingDirectory, stdout, stderr, interleavedOutput, exit, policy);
}

function serializeShellError(error: unknown): ToolCall {
  const result = error instanceof ShellToolRejectedError
    ? { case: "rejected" as const, value: new ShellRejected({ command: error.command, workingDirectory: error.workingDirectory ?? "", reason: error.reason }) }
    : error instanceof ShellToolPermissionDeniedError
      ? { case: "permissionDenied" as const, value: new ShellPermissionDenied({ command: error.command, workingDirectory: error.workingDirectory ?? "", error: error.error, isReadonly: error.isReadonly }) }
      : error instanceof ShellToolTimeoutError
        ? { case: "timeout" as const, value: new ShellTimeout({ command: error.command, workingDirectory: error.workingDirectory ?? "", timeoutMs: error.timeoutMs }) }
        : { case: "spawnError" as const, value: new ShellSpawnError({ error: error instanceof Error ? error.message : String(error) }) };
  return createShellToolCall(new ShellToolCall({ result: new ShellResult({ result }) }));
}

function renderShellOutput(result: ShellResult, options: ShellToolOptions): string {
  const common = {
    ...(result.sandboxPolicy === undefined ? {} : { sandboxPolicy: result.sandboxPolicy }),
    ...(result.isBackground === undefined ? {} : { isBackground: result.isBackground }),
    ...(options.terminalsFolder === undefined ? {} : { terminalsFolder: options.terminalsFolder }),
  };
  switch (result.result.case) {
    case "success": return renderShellResultToString({ ...common, result: { case: "success", value: result.result.value } }, { promptVersion: options.promptVersion, sandboxPromptEnabled: options.sandboxPromptEnabled ?? options.sandboxEnabled, useMinimalHarness: options.useMinimalHarness });
    case "failure": return renderShellResultToString({ ...common, result: { case: "failure", value: result.result.value } }, { promptVersion: options.promptVersion, sandboxPromptEnabled: options.sandboxPromptEnabled ?? options.sandboxEnabled, useMinimalHarness: options.useMinimalHarness });
    case "timeout": return renderShellResultToString({ ...common, result: { case: "timeout", value: result.result.value } }, { promptVersion: options.promptVersion, sandboxPromptEnabled: options.sandboxPromptEnabled ?? options.sandboxEnabled, useMinimalHarness: options.useMinimalHarness });
    case "rejected": return renderShellResultToString({ ...common, result: { case: "rejected", value: result.result.value } }, { promptVersion: options.promptVersion, sandboxPromptEnabled: options.sandboxPromptEnabled ?? options.sandboxEnabled, useMinimalHarness: options.useMinimalHarness });
    case "spawnError": return renderShellResultToString({ ...common, result: { case: "spawnError", value: result.result.value } }, { promptVersion: options.promptVersion, sandboxPromptEnabled: options.sandboxPromptEnabled ?? options.sandboxEnabled, useMinimalHarness: options.useMinimalHarness });
    case "permissionDenied": return renderShellResultToString({ ...common, result: { case: "permissionDenied", value: result.result.value } }, { promptVersion: options.promptVersion, sandboxPromptEnabled: options.sandboxPromptEnabled ?? options.sandboxEnabled, useMinimalHarness: options.useMinimalHarness });
    case undefined: return "Unknown error";
  }
}

/**
 * Uncomposed Shell factory. The caller supplies B1's executor through the
 * existing resource key; this module deliberately does not register a tool.
 * The same contract is used for the external host and isolated box surfaces.
 */
export function createShellTool(resourceAccessor: ShellToolResourceAccessor, options: ShellToolOptions = {}): ReturnType<typeof createZodAgentTool> | undefined {
  if (options.isPlatformEnabled?.(process.platform) === false) return undefined;
  const surface = options.surface ?? "host_machine";
  const promptVersion = options.promptVersion ?? "dsv3-1205";
  const sandboxEnabled = options.sandboxEnabled ?? false;
  const defaultBlockUntilMs = options.defaultBlockUntilMs ?? (options.agentType === "background" ? BACKGROUND_SHELL_DEFAULT_BLOCK_UNTIL_MS : DEFAULT_TIMEOUT_MS);
  const smartModeApprovalParametersEnabled = options.agentType !== AgentType.BACKGROUND && options.smartModeClassifierMode === true;
  const parameters = addSmartModeApprovalParameters(options.parametersSchema ?? getParametersSchemaDsv3(sandboxEnabled, promptVersion, { isReadonly: options.isReadonly, enableBlockUntilMs: options.enableBlockUntilMs, requireBlockUntilMs: options.requireBlockUntilMs, defaultBlockUntilMs }), smartModeApprovalParametersEnabled);
  const executor = resourceAccessor.get(shellStreamExecutorResource);
  const execute = async (ctx: Context, interaction: ShellToolInteractionHandler, rawArgs: Record<string, unknown>, meta: ShellToolExecutionMeta): Promise<ShellResult> => {
    const command = String(rawArgs.command);
    const workingDirectory = typeof rawArgs.working_directory === "string" ? rawArgs.working_directory : undefined;
    const analysis = analyzeShellCommand(command);
    const plan = resolvePlan(rawArgs, options);
    const policy = requestedPolicy(rawArgs, options, meta.workspacePaths);
    const request = { command, ...(workingDirectory === undefined ? {} : { workingDirectory }), isBackground: plan.shouldStartInBackground, analysis, executionPlan: plan, ...(policy === undefined ? {} : { requestedSandboxPolicy: policy }), surface };
    const decision = await options.preflight?.(ctx, request) ?? { allow: true as const };
    options.onAudit?.(ctx, request, decision);
    if (!decision.allow) throw new ShellToolRejectedError(command, workingDirectory, decision.reason);
    if (options.enforceModelFacingShellUiAutomationGuard === true) {
      const uiAutomationDecision = checkModelFacingShellUiAutomation(command);
      if (!uiAutomationDecision.allow) throw new ShellToolRejectedError(command, workingDirectory, uiAutomationDecision.reason);
    }
    const smartModeDecision = await runShellSmartModeClassifier(
      ctx,
      resourceAccessor,
      options,
      rawArgs,
      meta,
      command,
      workingDirectory,
      typeof rawArgs.description === "string" ? rawArgs.description : typeof rawArgs.explanation === "string" ? rawArgs.explanation : undefined,
      plan,
      policy,
      surface,
      interaction.getAbortSignal(ctx),
    );
    if (smartModeDecision.kind === "reject") throw new ShellToolRejectedError(command, workingDirectory, smartModeDecision.reason);
    let approvedShellBinding: { readonly executionStateIdentity?: string; readonly targetEnrichmentHash?: string } | undefined;
    let smartModeApprovalProviderApproved = false;
    if (smartModeDecision.kind === "block") {
      const approvalRequested = rawArgs.request_smart_mode_approval === true;
      const approvalProvider = options.smartModeApprovalProvider;
      if (!approvalRequested || approvalProvider === undefined) {
        throw new ShellToolRejectedError(command, workingDirectory, smartModeDecision.reason);
      }
      const approvalStateIdentity = options.smartModeShellApprovalState?.getIdentity();
      const target: ShellSmartModeApprovalTarget = {
        surface: options.smartModeApprovalSurface ?? (options.awaitToolIdentifier === "BOX_AWAIT" ? "isolated_box" : "host_machine"),
        command,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        ...(policy === undefined ? {} : { requestedSandboxPolicy: options.isReadonly === true ? policy : buildClassifierEscalatedSandboxPolicy(policy) }),
        isBackground: plan.shouldStartInBackground,
        isReadonly: options.isReadonly === true,
        executionPlan: plan,
        ...(approvalStateIdentity === undefined ? {} : { executionStateIdentity: approvalStateIdentity }),
        ...(smartModeDecision.targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash: smartModeDecision.targetEnrichmentHash }),
        blockReason: smartModeDecision.reason,
        ...(typeof rawArgs.description === "string" && rawArgs.description.trim().length > 0 ? { description: rawArgs.description.trim() } : typeof rawArgs.explanation === "string" && rawArgs.explanation.trim().length > 0 ? { description: rawArgs.explanation.trim() } : {}),
        ...(smartModeDecision.proposedAllowRule === undefined ? {} : { proposedAllowRule: smartModeDecision.proposedAllowRule }),
      };
      const approval = await withToolExecutionTimeoutSuspended(ctx, () => approvalProvider.requestApproval({
        kind: "shell",
        target,
        fingerprint: computeShellApprovalFingerprint(target),
        toolCallId: meta.toolCallId,
        conversationId: getConversationId(ctx),
        signal: interaction.getAbortSignal(ctx),
      }));
      if (interaction.getAbortSignal(ctx).aborted) throw new ToolCallAbortedError();
      if (!approval.approved) throw new ShellToolRejectedError(command, workingDirectory, approval.reason ?? smartModeDecision.reason);
      smartModeApprovalProviderApproved = true;
      approvedShellBinding = {
        ...(target.executionStateIdentity === undefined ? {} : { executionStateIdentity: target.executionStateIdentity }),
        ...(target.targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash: target.targetEnrichmentHash }),
      };
    } else if (smartModeDecision.kind === "allow" && smartModeDecision.enabled && (options.smartModeShellTargetEnrichmentProvider !== undefined || options.smartModeShellApprovalState !== undefined)) {
      const approvalStateIdentity = options.smartModeShellApprovalState?.getIdentity();
      approvedShellBinding = {
        ...(approvalStateIdentity === undefined ? {} : { executionStateIdentity: approvalStateIdentity }),
        ...(smartModeDecision.targetEnrichmentHash === undefined ? {} : { targetEnrichmentHash: smartModeDecision.targetEnrichmentHash }),
      };
    }
    options.onTelemetry?.(ctx, { type: "started", toolCallId: meta.toolCallId });
    const args = shellArgs(rawArgs, analysis, plan, options, meta, policy, smartModeApprovalProviderApproved || (smartModeDecision.kind === "allow" && smartModeDecision.enabled));
    const call = createShellToolCall(new ShellToolCall({ args }));
    if (plan.shouldStartInBackground) await interaction.emitPartialToolCall?.(ctx, meta.toolCallId, call);
    const result = await interaction.executeToolCall(ctx, call, meta.toolCallId, async executionCtx => {
      if (interaction.getAbortSignal(executionCtx).aborted) throw new ToolCallAbortedError();
      if (approvedShellBinding !== undefined) {
        const currentIdentity = options.smartModeShellApprovalState?.getIdentity();
        const currentEnrichment = await options.smartModeShellTargetEnrichmentProvider?.(executionCtx, {
          resourceAccessor,
          command,
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
          toolCallId: meta.toolCallId,
        });
        const currentHash = hashTargetEnrichment(currentEnrichment);
        if (currentIdentity !== approvedShellBinding.executionStateIdentity || currentHash !== approvedShellBinding.targetEnrichmentHash) {
          throw new ShellToolRejectedError(command, workingDirectory, "The reviewed shell target changed before execution; retry the command for a new review.");
        }
        approvedShellBinding = undefined;
      }
      options.smartModeShellApprovalState?.markSideEffectStart();
      const lock = options.fileOperationLockManager === undefined ? undefined : await options.fileOperationLockManager.waitForExclusiveLock(executionCtx);
      try { return await executeStream(executionCtx, executor, args, interaction, meta, options, policy); }
      finally { lock?.[Symbol.dispose](); }
    }, merged => createShellToolCall(new ShellToolCall({ args, result: merged })), meta.hookContextCollector);
    options.onTelemetry?.(ctx, { type: "finished", toolCallId: meta.toolCallId });
    return result;
  };
  const toolName = options.toolName ?? (surface === "isolated_box" ? "run-command" : "run_terminal_cmd");
  return createZodAgentTool(options.toolIdentifier ?? "SHELL", {
    name: toolName,
    descriptionGenerator: (descriptionProps: { readonly allTools?: Record<string, { readonly name?: string }> } = {}) => getDescriptionDsv3(sandboxEnabled, promptVersion, {
      isReadonly: options.isReadonly,
      enableBlockUntilMs: options.enableBlockUntilMs,
      requireBlockUntilMs: options.requireBlockUntilMs,
      defaultBlockUntilMs,
      useMinimalHarness: options.useMinimalHarness,
      enableJobCompletionNotifications: options.enableJobCompletionNotifications,
      enableTerminalFiles: options.enableTerminalFiles,
      awaitToolName: options.awaitToolIdentifier === undefined ? undefined : descriptionProps.allTools?.[options.awaitToolIdentifier]?.name ?? options.awaitToolIdentifier,
      readToolName: options.readToolIdentifier === undefined ? undefined : descriptionProps.allTools?.[options.readToolIdentifier]?.name ?? options.readToolIdentifier,
    }),
    parameters,
    execute: withSafeParsedArgs(parameters, execute, createShellToolCall(new ShellToolCall({ args: new ShellArgs() }))),
    render: async (_ctx: Context, result: ShellResult) => createStringResult(renderShellOutput(result, { ...options, promptVersion })),
    serializeError: serializeShellError,
  });
}

export const SHELL_TOOL_FACTORY_PLACEMENT = "turn-toolset:externalShell|boxShell" as const;
