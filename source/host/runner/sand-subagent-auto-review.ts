import { Struct } from "@bufbuild/protobuf";
import { SmartModeRiskTarget } from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";
import {
  fingerprintSandAutoReviewTarget,
  type SandAutoReviewController,
  type SandAutoReviewExpiryPolicy,
  type SandAutoReviewMode,
} from "./sand-auto-review.js";
import type { AutoReviewClassifierDecision } from "./sand-auto-review-classifier-run.js";
import { buildProjectPermissionsContext } from "./sand-computer-auto-review.js";
import { summarizeSandSubagentAction } from "./sand-auto-review-summaries.js";

export const SAND_SUBAGENT_CLASSIFIER_TARGET_ACTION = "sand_subagent";
export const SAND_SUBAGENT_CLASSIFIER_ERROR_REASON =
  "An error occurred while reviewing this task. Please review manually.";

export interface SubagentReviewTarget {
  readonly action: "launch" | "steer";
  readonly prompt: string;
  readonly subagentType?: string;
  readonly subagentAgentId?: string;
  readonly readonly?: boolean;
  readonly resume?: boolean;
}

export interface InstructionPermissions {
  readonly allowInstructions?: readonly string[];
  readonly blockInstructions?: readonly string[];
}

export function buildSandSubagentLaunchReviewTarget(args: {
  readonly prompt: string;
  readonly subagentType?: string;
  readonly readonly?: boolean;
  readonly resume?: boolean;
}): SubagentReviewTarget | undefined {
  const prompt = args.prompt.trim();
  if (prompt.length === 0) return undefined;
  return {
    action: "launch",
    prompt,
    ...(args.subagentType != null && args.subagentType.length > 0
      ? { subagentType: args.subagentType }
      : {}),
    ...(args.readonly == null ? {} : { readonly: args.readonly }),
    ...(args.resume == null ? {} : { resume: args.resume }),
  };
}

export function buildSandSubagentSteerReviewTarget(args: {
  readonly message: string;
  readonly subagentAgentId: string;
  readonly subagentType?: string;
}): SubagentReviewTarget | undefined {
  const prompt = args.message.trim();
  if (prompt.length === 0) return undefined;
  return {
    action: "steer",
    prompt,
    subagentAgentId: args.subagentAgentId,
    ...(args.subagentType != null && args.subagentType.length > 0
      ? { subagentType: args.subagentType }
      : {}),
  };
}

export function buildSandSubagentRiskTarget(args: {
  readonly target: SubagentReviewTarget;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
}) {
  const { target } = args;
  const argumentsJson = JSON.parse(JSON.stringify({
      surface: "subagent",
      action: target.action,
      prompt: target.prompt,
      subagent_type: target.subagentType,
      subagent_agent_id: target.subagentAgentId,
      readonly: target.readonly,
      resume: target.resume,
      project_permissions: buildProjectPermissionsContext(args),
    }));
  return new SmartModeRiskTarget({
    action: SAND_SUBAGENT_CLASSIFIER_TARGET_ACTION,
    arguments: Struct.fromJson(argumentsJson),
  });
}

export interface SubagentReviewOptions<Context> {
  readonly mode: SandAutoReviewMode;
  readonly agentId: string;
  readonly autoReviewController?: Pick<SandAutoReviewController, "requestApproval">;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
  readonly getApprovalExpiryPolicy?: () => SandAutoReviewExpiryPolicy;
  classify(
    context: Context,
    target: SubagentReviewTarget,
    mode: "shadow" | "enforce",
    toolCallId: string,
  ): Promise<AutoReviewClassifierDecision>;
  reportShadowFailure?(error: unknown): void;
  suspendToolExecutionTimeout?<T>(context: Context, operation: () => Promise<T>): Promise<T>;
}

const CANCELLED_SUBAGENT_REVIEW = {
  allowed: false,
  reason: "The task was cancelled.",
} as const;

export async function reviewSandSubagentAction<Context>(args: {
  readonly ctx: Context;
  readonly target: SubagentReviewTarget;
  readonly options: SubagentReviewOptions<Context>;
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
  const { ctx, target, options, toolCallId } = args;
  if (options.mode === "off") return { allowed: true };
  if (options.mode === "shadow") {
    void options.classify(ctx, target, "shadow", toolCallId)
      .catch((error: unknown) => options.reportShadowFailure?.(error));
    return { allowed: true };
  }
  const cancelled = () => args.signal?.aborted === true;
  if (cancelled()) return CANCELLED_SUBAGENT_REVIEW;
  const decision = await options.classify(ctx, target, "enforce", toolCallId);
  if (cancelled()) return CANCELLED_SUBAGENT_REVIEW;
  if (decision.kind === "allow") return { allowed: true };
  const controller = options.autoReviewController;
  if (decision.kind !== "block" || controller == null) {
    return { allowed: false, reason: decision.reason };
  }
  const request = () => controller.requestApproval({
    agentId: options.agentId,
    surface: "subagent",
    fingerprint: fingerprintSandAutoReviewTarget({
      action: target.action,
      prompt: target.prompt,
      subagentType: target.subagentType,
      subagentAgentId: target.subagentAgentId,
      readonly: target.readonly,
      resume: target.resume,
    }),
    reason: decision.reason,
    summary: summarizeSandSubagentAction({ action: target.action, prompt: target.prompt }),
    ...(decision.proposedRule == null ? {} : { proposedRule: decision.proposedRule }),
    ...(args.signal == null ? {} : { signal: args.signal }),
    ...(options.getApprovalExpiryPolicy == null
      ? {}
      : { expiryPolicy: options.getApprovalExpiryPolicy() }),
  });
  const approval = options.suspendToolExecutionTimeout == null
    ? await request()
    : await options.suspendToolExecutionTimeout(ctx, request);
  if (cancelled()) return CANCELLED_SUBAGENT_REVIEW;
  return approval.approved
    ? { allowed: true }
    : { allowed: false, reason: approval.reason ?? decision.reason };
}
