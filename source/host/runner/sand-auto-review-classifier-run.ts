import type { Context } from "../../packages/context/core.js";
import { smartModeClassifierExecutorResource } from "../../packages/agent-exec/smart-mode-classifier.js";
import type { RemoteExecManager } from "../../packages/agent-exec/remote.js";
import type { ResourceAccessor } from "../../packages/agent-exec/resource-provider.js";
import { getConversationId } from "../../packages/agent/utils/request-id.js";
import { executeSmartModeClassifierWithMeasurement } from "../../packages/agent/utils/smart-mode-classifier-measurement.js";
import {
  SmartModeClassifierArgs,
  SmartModeClassifierDecision,
  type SmartModeClassifierConversationMessage,
  SmartModeRiskTarget,
} from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";

export const SAND_AUTO_REVIEW_BLOCK_REASON = "Blocked by Auto-review";
export const SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS = 1;

export type AutoReviewClassifierDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly reason: string; readonly proposedRule?: string }
  | { readonly kind: "reject"; readonly reason: string };

export async function runSandAutoReviewClassifier(args: {
  readonly ctx: Context;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly toolCallId: string;
  readonly mode: "shadow" | "enforce";
  readonly buildTarget: () => SmartModeRiskTarget;
  readonly loadConversationContext: () => Promise<SmartModeClassifierConversationMessage[]>;
  readonly workspacePaths?: readonly string[];
  readonly errorReason: string;
}): Promise<AutoReviewClassifierDecision> {
  try {
    const executor = args.resourceAccessor.get(smartModeClassifierExecutorResource);
    const parentConversationId = getConversationId(args.ctx);
    const result = await executeSmartModeClassifierWithMeasurement(
      args.ctx,
      executor,
      new SmartModeClassifierArgs({
        toolCallId: args.toolCallId,
        parentConversationId: parentConversationId!,
        target: args.buildTarget(),
        conversationContext: await args.loadConversationContext(),
      }),
      args.mode,
      args.workspacePaths,
      {
        suppressToolCallIdLogging: true,
        maxAttempts: SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS,
      },
    );
    if (result.result.case !== "success") {
      return { kind: "reject", reason: args.errorReason };
    }
    const { decision, blockReason, proposedAllowRule } = result.result.value;
    if (decision === SmartModeClassifierDecision.BLOCK) {
      const proposedRule = proposedAllowRule?.trim();
      return {
        kind: "block",
        reason: blockReason?.trim() || SAND_AUTO_REVIEW_BLOCK_REASON,
        ...(proposedRule !== undefined && proposedRule.length > 0 ? { proposedRule } : {}),
      };
    }
    return decision === SmartModeClassifierDecision.ALLOW
      ? { kind: "allow" }
      : { kind: "reject", reason: args.errorReason };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { kind: "reject", reason: args.errorReason };
  }
}
