import type { Context } from "../../context/core.js";
import { createKey } from "../../context/core.js";
import { createLogger } from "../../context/logger.js";
import type { Executor } from "../../agent-exec/remote.js";
import { SmartModeClassifierDecision, type SmartModeClassifierArgs, type SmartModeClassifierResult } from "../../proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";
import { withTimeout } from "../../utils/promise-extras.js";
import { getAgentEventTracker } from "./event-tracking.js";
import { parseSmartModeClassifierFailureMetadata } from "./smart-mode-classifier-error-metadata.js";

const logger = createLogger("@anysphere/agent:smart-mode-classifier");
const SMART_MODE_CLASSIFIER_TIMEOUT_MS = 10_000;
const SMART_MODE_CLASSIFIER_LOCAL_DEV_TIMEOUT_MULTIPLIER = 3;
const SMART_MODE_CLASSIFIER_MAX_TOTAL_ATTEMPTS = 2;
const SMART_MODE_CLASSIFIER_MAX_FAILURE_RETRIES = SMART_MODE_CLASSIFIER_MAX_TOTAL_ATTEMPTS - 1;

export const smartModeClassifierAttemptIndexKey = createKey<number | undefined>(Symbol("smartModeClassifierAttemptIndex"), undefined);
export const smartModeClassifierModeKey = createKey<string | undefined>(Symbol("smartModeClassifierMode"), undefined);
export const smartModeClassifierWorkspacePathsKey = createKey<readonly string[] | undefined>(Symbol("smartModeClassifierWorkspacePaths"), undefined);

function getSmartModeClassifierTimeoutMs(): number {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
    return SMART_MODE_CLASSIFIER_TIMEOUT_MS * SMART_MODE_CLASSIFIER_LOCAL_DEV_TIMEOUT_MULTIPLIER;
  }
  return SMART_MODE_CLASSIFIER_TIMEOUT_MS;
}

export interface SmartModeClassifierMeasurementOptions {
  readonly maxAttempts?: number | undefined;
  readonly suppressToolCallIdLogging?: boolean | undefined;
}

export async function executeSmartModeClassifierWithMeasurement(
  ctx: Context,
  executor: Executor<SmartModeClassifierArgs, SmartModeClassifierResult>,
  args: SmartModeClassifierArgs,
  mode: string = "enforce",
  workspacePaths?: readonly string[],
  options?: SmartModeClassifierMeasurementOptions,
): Promise<SmartModeClassifierResult> {
  const overallStartTime = performance.now();
  const actionKind = normalizeSmartModeClassifierActionKind(args.target?.action);
  const surfaceLabel = getSmartModeClassifierSurfaceLabel(args);
  const maxAttempts = Math.max(1, options?.maxAttempts ?? SMART_MODE_CLASSIFIER_MAX_TOTAL_ATTEMPTS);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timeoutMs = getSmartModeClassifierTimeoutMs();
    const timeoutMessage = `Smart Mode classifier timed out after ${timeoutMs}ms`;
    const attemptIndex = attempt - 1;
    const [cancelableAttemptCtx, cancelAttempt] = ctx.withCancel();
    const attemptCtx = cancelableAttemptCtx
      .with(smartModeClassifierAttemptIndexKey, attemptIndex)
      .with(smartModeClassifierModeKey, mode)
      .with(smartModeClassifierWorkspacePathsKey, workspacePaths);
    recordSmartModeClassifierStart(ctx, {
      mode,
      actionKind,
      surfaceLabel,
      timeoutMs,
      hasTarget: args.target !== undefined,
      hasTargetArguments: args.target?.arguments !== undefined,
    }, options?.suppressToolCallIdLogging === true ? undefined : args.toolCallId);
    try {
      const result = await withTimeout(Promise.resolve().then(() => executor.execute(attemptCtx, args)), timeoutMs, timeoutMessage);
      const classifiedResult = classifySmartModeClassifierResult(result);
      const retryable = isRetryableClassifierFailure(classifiedResult);
      if (retryable && attempt < maxAttempts) continue;
      recordSmartModeClassifierCall(ctx, {
        mode,
        actionKind,
        surfaceLabel,
        ...classifiedResult,
        latencyMs: elapsedMs(overallStartTime),
        retryCount: attempt - 1,
      }, options?.suppressToolCallIdLogging === true ? undefined : args.toolCallId);
      return result;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        recordSmartModeClassifierException(ctx, {
          mode,
          actionKind,
          surfaceLabel,
          latencyMs: elapsedMs(overallStartTime),
          retryCount: attempt - 1,
        }, options?.suppressToolCallIdLogging === true ? undefined : args.toolCallId);
        throw error;
      }
      const failureReason = classifySmartModeClassifierException(error);
      if (failureReason === "timeout_exception") cancelAttempt(new Error(timeoutMessage));
      if (attempt < maxAttempts) continue;
      recordSmartModeClassifierException(ctx, {
        mode,
        actionKind,
        surfaceLabel,
        latencyMs: elapsedMs(overallStartTime),
        retryCount: attempt - 1,
        failureReason,
      }, options?.suppressToolCallIdLogging === true ? undefined : args.toolCallId);
      throw error;
    }
  }
  throw new Error("Smart Mode classifier retry loop exited unexpectedly");
}

function normalizeSmartModeClassifierActionKind(action: string | undefined): string {
  const normalizedAction = action?.trim().toLowerCase();
  if (normalizedAction === undefined || normalizedAction.length === 0) return "unknown";
  if (normalizedAction === "shell" || normalizedAction === "mcp" || normalizedAction === "sand_computer" || normalizedAction === "web_fetch" || normalizedAction === "fetch_mcp_resource") {
    return normalizedAction;
  }
  return "other";
}

function getSmartModeClassifierSurfaceLabel(args: SmartModeClassifierArgs): string | undefined {
  const json = args.target?.arguments?.toJson();
  if (json === null || Array.isArray(json) || typeof json !== "object") return undefined;
  const surface = (json as Record<string, unknown>).execution_surface;
  return surface === "host_machine" || surface === "isolated_box" ? surface : undefined;
}

interface ClassifiedSmartModeClassifierResult {
  readonly outcome: "allow" | "block" | "error" | "missing";
  readonly decision: "allow" | "block" | "unspecified" | "unknown";
  readonly hasReason: boolean;
  readonly failureReason?: string;
  readonly retryable?: boolean;
}

function classifySmartModeClassifierResult(result: SmartModeClassifierResult): ClassifiedSmartModeClassifierResult {
  switch (result.result.case) {
    case "success": {
      const decision = smartModeDecisionToLabel(result.result.value.decision);
      const failureMetadata = getSmartModeClassifierDecisionFailureMetadata(decision);
      return {
        outcome: smartModeDecisionToOutcome(result.result.value.decision),
        decision,
        hasReason: result.result.value.blockReason !== undefined,
        ...failureMetadata,
      };
    }
    case "error": {
      const metadata = parseSmartModeClassifierFailureMetadata(result.result.value.error);
      return {
        outcome: "error",
        decision: "unknown",
        hasReason: false,
        failureReason: metadata?.failureReason ?? "classifier_result_error",
        retryable: metadata?.retryable ?? true,
      };
    }
    default:
      return {
        outcome: "missing",
        decision: "unknown",
        hasReason: false,
        failureReason: "missing_result",
        retryable: true,
      };
  }
}

function smartModeDecisionToOutcome(decision: SmartModeClassifierDecision): "allow" | "block" | "missing" {
  switch (decision) {
    case SmartModeClassifierDecision.ALLOW: return "allow";
    case SmartModeClassifierDecision.BLOCK: return "block";
    case SmartModeClassifierDecision.UNSPECIFIED: return "missing";
    default: return "missing";
  }
}

function smartModeDecisionToLabel(decision: SmartModeClassifierDecision): "allow" | "block" | "unspecified" | "unknown" {
  switch (decision) {
    case SmartModeClassifierDecision.ALLOW: return "allow";
    case SmartModeClassifierDecision.BLOCK: return "block";
    case SmartModeClassifierDecision.UNSPECIFIED: return "unspecified";
    default: return "unknown";
  }
}

function getSmartModeClassifierDecisionFailureMetadata(decision: ClassifiedSmartModeClassifierResult["decision"]): { readonly failureReason?: string; readonly retryable?: boolean } {
  switch (decision) {
    case "allow":
    case "block":
      return { retryable: false };
    case "unspecified":
      return { failureReason: "unspecified_decision", retryable: true };
    case "unknown":
      return { failureReason: "unknown_decision", retryable: true };
  }
}

function isRetryableClassifierFailure(result: ClassifiedSmartModeClassifierResult): boolean {
  if (result.outcome === "allow" || result.outcome === "block") return false;
  return result.retryable ?? true;
}

function classifySmartModeClassifierException(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.message.includes("Smart Mode classifier timed out"))) {
    return "timeout_exception";
  }
  return "unknown_exception";
}

function elapsedMs(startTime: number): number {
  return Math.max(0, Math.round(performance.now() - startTime));
}

interface SmartModeClassifierCallMeasurement {
  readonly mode: string;
  readonly actionKind: string;
  readonly surfaceLabel: string | undefined;
  readonly outcome: string;
  readonly decision: string;
  readonly hasReason: boolean;
  readonly latencyMs: number;
  readonly retryCount: number;
  readonly failureReason?: string;
  readonly retryable?: boolean;
}

interface SmartModeClassifierStartMeasurement {
  readonly mode: string;
  readonly actionKind: string;
  readonly surfaceLabel: string | undefined;
  readonly timeoutMs: number;
  readonly hasTarget: boolean;
  readonly hasTargetArguments: boolean;
}

interface SmartModeClassifierExceptionMeasurement {
  readonly mode: string;
  readonly actionKind: string;
  readonly surfaceLabel: string | undefined;
  readonly latencyMs: number;
  readonly retryCount: number;
  readonly failureReason?: string;
}

function recordSmartModeClassifierCall(ctx: Context, options: SmartModeClassifierCallMeasurement, toolCallId: string | undefined): void {
  try {
    logger.info(ctx, "smart_mode.classifier_call", {
      mode: options.mode,
      actionKind: options.actionKind,
      surfaceLabel: options.surfaceLabel,
      outcome: options.outcome,
      decision: options.decision,
      hasReason: options.hasReason,
      latencyMs: options.latencyMs,
      retryCount: options.retryCount,
      failureReason: options.failureReason,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    });
  } catch {
  }
  try {
    getAgentEventTracker(ctx).trackSmartModeClassifierCall(ctx, options);
  } catch {
  }
}

function recordSmartModeClassifierStart(ctx: Context, options: SmartModeClassifierStartMeasurement, toolCallId: string | undefined): void {
  try {
    logger.info(ctx, "smart_mode.classifier_call.started", {
      mode: options.mode,
      actionKind: options.actionKind,
      surfaceLabel: options.surfaceLabel,
      timeoutMs: options.timeoutMs,
      hasTarget: options.hasTarget,
      hasTargetArguments: options.hasTargetArguments,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    });
  } catch {
  }
}

function recordSmartModeClassifierException(ctx: Context, options: SmartModeClassifierExceptionMeasurement, toolCallId: string | undefined): void {
  recordSmartModeClassifierCall(ctx, {
    ...options,
    outcome: "exception",
    decision: "unknown",
    hasReason: false,
  }, toolCallId);
}

void SMART_MODE_CLASSIFIER_MAX_FAILURE_RETRIES;
