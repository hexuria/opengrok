import { Struct } from "@bufbuild/protobuf";
import { describeTrigger } from "../../shared/automation-schedule.js";
import { triggerSchedule, type AutomationTrigger } from "../../shared/automations.js";
import { serializeStoredTrigger } from "../automations/automation-trigger.js";
import { SmartModeRiskTarget } from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";
import {
  fingerprintSandAutoReviewTarget,
  type SandAutoReviewController,
  type SandAutoReviewExpiryPolicy,
  type SandAutoReviewMode,
} from "./sand-auto-review.js";
import type { AutoReviewClassifierDecision } from "./sand-auto-review-classifier-run.js";
import { summarizeSandAutomationWriteAction } from "./sand-auto-review-summaries.js";
import { buildProjectPermissionsContext } from "./sand-computer-auto-review.js";
import type { InstructionPermissions } from "./sand-subagent-auto-review.js";

export const SAND_AUTOMATION_WRITE_CLASSIFIER_TARGET_ACTION = "sand_automation_write";
export const SAND_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON =
  "An error occurred while reviewing this routine. Please review manually.";

export interface AutomationReference {
  readonly id: string;
  readonly name: string;
  readonly body?: string;
  readonly prompt?: string;
}

export interface AutomationWriteTarget {
  readonly operation: string;
  readonly id: string;
  readonly spec: {
    readonly name: string;
    readonly prompt: string;
    readonly trigger: AutomationTrigger;
    readonly isEnabled: boolean;
  };
  readonly referencedWorkflows?: readonly AutomationReference[];
  readonly referencingRoutines?: readonly AutomationReference[];
}

export function buildSandAutomationWriteRiskTarget(args: {
  readonly target: AutomationWriteTarget;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
}) {
  const { operation, id, spec, referencedWorkflows, referencingRoutines } = args.target;
  const argumentsJson = JSON.parse(JSON.stringify({
      surface: "automation_write",
      operation,
      automation_id: id,
      name: spec.name,
      prompt: spec.prompt,
      trigger: serializeStoredTrigger(spec.trigger),
      schedule: triggerSchedule(spec.trigger) ?? undefined,
      trigger_description: describeTrigger(spec.trigger),
      enabled: spec.isEnabled,
      referenced_workflows: referencedWorkflows?.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        body: workflow.body,
      })) ?? [],
      referencing_routines: referencingRoutines?.map((routine) => ({
        id: routine.id,
        name: routine.name,
        prompt: routine.prompt,
      })) ?? [],
      project_permissions: buildProjectPermissionsContext(args),
    }));
  return new SmartModeRiskTarget({
    action: SAND_AUTOMATION_WRITE_CLASSIFIER_TARGET_ACTION,
    arguments: Struct.fromJson(argumentsJson),
  });
}

export interface AutomationReviewOptions<Context> {
  readonly mode: SandAutoReviewMode;
  readonly agentId: string;
  readonly autoReviewController?: Pick<SandAutoReviewController, "requestApproval">;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
  readonly getApprovalExpiryPolicy?: () => SandAutoReviewExpiryPolicy;
  classify(
    context: Context,
    target: AutomationWriteTarget,
    mode: "shadow" | "enforce",
    toolCallId: string,
  ): Promise<AutoReviewClassifierDecision>;
  reportShadowFailure?(error: unknown): void;
  suspendToolExecutionTimeout?<T>(context: Context, operation: () => Promise<T>): Promise<T>;
}

export async function reviewSandAutomationWrite<Context>(args: {
  readonly ctx: Context;
  readonly target: AutomationWriteTarget;
  readonly options: AutomationReviewOptions<Context>;
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
  const decision = await options.classify(ctx, target, "enforce", toolCallId);
  if (decision.kind === "allow") return { allowed: true };
  const controller = options.autoReviewController;
  if (decision.kind !== "block" || controller == null) {
    return { allowed: false, reason: decision.reason };
  }
  const request = () => controller.requestApproval({
    agentId: options.agentId,
    surface: "automation_write",
    fingerprint: fingerprintSandAutoReviewTarget({
      operation: target.operation,
      id: target.id,
      spec: target.spec,
      referencedWorkflows: target.referencedWorkflows ?? [],
      referencingRoutines: target.referencingRoutines ?? [],
    }),
    reason: decision.reason,
    summary: summarizeSandAutomationWriteAction({
      operation: target.operation,
      name: target.spec.name,
      triggerDescription: describeTrigger(target.spec.trigger),
      prompt: target.spec.prompt,
      isEnabled: target.spec.isEnabled,
      ...(target.referencingRoutines == null
        ? {}
        : { referencingRoutineNames: target.referencingRoutines.map((routine) => routine.name) }),
    }),
    ...(decision.proposedRule == null ? {} : { proposedRule: decision.proposedRule }),
    ...(args.signal == null ? {} : { signal: args.signal }),
    ...(options.getApprovalExpiryPolicy == null
      ? {}
      : { expiryPolicy: options.getApprovalExpiryPolicy() }),
  });
  const approval = options.suspendToolExecutionTimeout == null
    ? await request()
    : await options.suspendToolExecutionTimeout(ctx, request);
  return approval.approved
    ? { allowed: true }
    : { allowed: false, reason: approval.reason ?? decision.reason };
}
