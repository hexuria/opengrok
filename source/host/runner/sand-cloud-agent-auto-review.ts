import { Struct } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { SmartModeRiskTarget } from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";
import {
  fingerprintSandAutoReviewTarget,
  type SandAutoReviewController,
  type SandAutoReviewExpiryPolicy,
  type SandAutoReviewMode,
} from "./sand-auto-review.js";
import type { AutoReviewClassifierDecision } from "./sand-auto-review-classifier-run.js";
import {
  summarizeSandCloudAgentAction,
  summarizeSandCloudAgentLifecycleAction,
  type CloudLifecycleAction,
} from "./sand-auto-review-summaries.js";
import { buildProjectPermissionsContext } from "./sand-computer-auto-review.js";
import type { InstructionPermissions } from "./sand-subagent-auto-review.js";

export const SAND_CLOUD_AGENT_CLASSIFIER_TARGET_ACTION = "sand_cloud_agent";
export const SAND_CLOUD_AGENT_CLASSIFIER_ERROR_REASON =
  "An error occurred while reviewing this cloud agent action. Please review manually.";
export const SAND_CLOUD_AGENT_AUTO_REVIEW_ACTIONS = ["launch", "reply"] as const;
export const SAND_CLOUD_AGENT_LIFECYCLE_REVIEW_ACTIONS = [
  "rename",
  "cancel",
  "archive",
  "unarchive",
  "delete",
] as const;

const REVIEWABLE_ACTIONS = new Set<string>(SAND_CLOUD_AGENT_AUTO_REVIEW_ACTIONS);
const LIFECYCLE_REVIEW_ACTIONS = new Set<string>(SAND_CLOUD_AGENT_LIFECYCLE_REVIEW_ACTIONS);

export type CloudAgentReviewAction = typeof SAND_CLOUD_AGENT_AUTO_REVIEW_ACTIONS[number];

export interface CloudAgentReviewImage {
  readonly url: string;
  readonly mimeType?: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface CloudAgentReviewTarget {
  readonly action: CloudAgentReviewAction;
  readonly prompt: string;
  readonly repoUrl?: string;
  readonly startingRef?: string;
  readonly model?: string;
  readonly modelParams?: unknown;
  readonly title?: string;
  readonly environment?: unknown;
  readonly agentId?: string;
  readonly interrupt?: boolean;
  readonly images: readonly CloudAgentReviewImage[];
}

export interface CloudAgentLifecycleReviewTarget {
  readonly action: CloudLifecycleAction;
  readonly agentId: string;
  readonly title?: string;
}

export function isSandCloudAgentAutoReviewAction(
  action: string,
): action is CloudAgentReviewAction {
  return REVIEWABLE_ACTIONS.has(action);
}

export function isSandCloudAgentLifecycleReviewAction(
  action: string,
): action is CloudLifecycleAction {
  return LIFECYCLE_REVIEW_ACTIONS.has(action);
}

export function describeSandCloudAgentReviewImages(
  urls: readonly string[],
  images: readonly { readonly path?: string; readonly mimeType?: string; readonly data: Uint8Array }[],
): CloudAgentReviewImage[] {
  return images.map((image, index) => ({
    url: image.path ?? urls[index] ?? `image-${index}`,
    ...(image.mimeType == null ? {} : { mimeType: image.mimeType }),
    byteLength: image.data.byteLength,
    sha256: createHash("sha256").update(image.data).digest("hex"),
  }));
}

export function buildSandCloudAgentReviewTarget(
  args: {
    readonly action: string;
    readonly prompt?: string;
    readonly repo_url?: string;
    readonly starting_ref?: string;
    readonly model?: string;
    readonly model_params?: unknown;
    readonly title?: string;
    readonly environment?: unknown;
    readonly agent_id?: string;
    readonly interrupt?: boolean;
  },
  images: readonly CloudAgentReviewImage[] = [],
): CloudAgentReviewTarget | undefined {
  if (!isSandCloudAgentAutoReviewAction(args.action)) return undefined;
  const prompt = args.prompt?.trim() ?? "";
  if (prompt.length === 0) return undefined;
  return {
    action: args.action,
    prompt,
    ...(args.repo_url == null ? {} : { repoUrl: args.repo_url }),
    ...(args.starting_ref == null ? {} : { startingRef: args.starting_ref }),
    ...(args.model == null ? {} : { model: args.model }),
    ...(args.model_params == null ? {} : { modelParams: args.model_params }),
    ...(args.title == null ? {} : { title: args.title }),
    ...(args.environment == null ? {} : { environment: args.environment }),
    ...(args.agent_id == null ? {} : { agentId: args.agent_id }),
    ...(args.interrupt == null ? {} : { interrupt: args.interrupt }),
    images,
  };
}

export function buildSandCloudAgentRiskTarget(args: {
  readonly target: CloudAgentReviewTarget;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
}) {
  const { target } = args;
  const argumentsJson = JSON.parse(JSON.stringify({
      surface: "cloud_agent",
      action: target.action,
      prompt: target.prompt,
      repo_url: target.repoUrl,
      starting_ref: target.startingRef,
      model: target.model,
      model_params: target.modelParams,
      title: target.title,
      environment: target.environment,
      agent_id: target.agentId,
      interrupt: target.interrupt,
      image_count: target.images.length,
      images: target.images.map((image) => ({
        url: image.url,
        mime_type: image.mimeType,
        byte_length: image.byteLength,
        sha256: image.sha256,
      })),
      project_permissions: buildProjectPermissionsContext(args),
    }));
  return new SmartModeRiskTarget({
    action: SAND_CLOUD_AGENT_CLASSIFIER_TARGET_ACTION,
    arguments: Struct.fromJson(argumentsJson),
  });
}

export interface CloudAgentReviewOptions<Context> {
  readonly mode: SandAutoReviewMode;
  readonly agentId: string;
  readonly autoReviewController?: Pick<SandAutoReviewController, "requestApproval">;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
  readonly getApprovalExpiryPolicy?: () => SandAutoReviewExpiryPolicy;
  classify(
    context: Context,
    target: CloudAgentReviewTarget,
    mode: "shadow" | "enforce",
    toolCallId: string,
  ): Promise<AutoReviewClassifierDecision>;
  reportShadowFailure?(error: unknown): void;
  suspendToolExecutionTimeout?<T>(context: Context, operation: () => Promise<T>): Promise<T>;
}

const CANCELLED_CLOUD_AGENT_REVIEW = {
  allowed: false,
  reason: "The cloud agent action was cancelled.",
} as const;

export async function reviewSandCloudAgentAction<Context>(args: {
  readonly ctx: Context;
  readonly target: CloudAgentReviewTarget;
  readonly options: CloudAgentReviewOptions<Context>;
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
  if (cancelled()) return CANCELLED_CLOUD_AGENT_REVIEW;
  const decision = await options.classify(ctx, target, "enforce", toolCallId);
  if (cancelled()) return CANCELLED_CLOUD_AGENT_REVIEW;
  if (decision.kind === "allow") return { allowed: true };
  const controller = options.autoReviewController;
  if (decision.kind !== "block" || controller == null) {
    return { allowed: false, reason: decision.reason };
  }
  const request = () => controller.requestApproval({
    agentId: options.agentId,
    surface: "cloud_agent",
    fingerprint: fingerprintSandAutoReviewTarget({
      action: target.action,
      prompt: target.prompt,
      repoUrl: target.repoUrl,
      startingRef: target.startingRef,
      model: target.model,
      modelParams: target.modelParams,
      title: target.title,
      environment: target.environment,
      agentId: target.agentId,
      interrupt: target.interrupt,
      images: target.images,
    }),
    reason: decision.reason,
    summary: summarizeSandCloudAgentAction({
      ...target,
      imageCount: target.images.length,
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
  if (cancelled()) return CANCELLED_CLOUD_AGENT_REVIEW;
  return approval.approved
    ? { allowed: true }
    : { allowed: false, reason: approval.reason ?? decision.reason };
}

export function buildSandCloudAgentLifecycleReviewTarget(args: {
  readonly action: string;
  readonly agent_id?: string;
  readonly title?: string;
}): CloudAgentLifecycleReviewTarget | undefined {
  if (!isSandCloudAgentLifecycleReviewAction(args.action)) return undefined;
  const agentId = args.agent_id?.trim() ?? "";
  if (agentId.length === 0) return undefined;
  const title = args.title?.trim();
  return {
    action: args.action,
    agentId,
    ...(title == null || title.length === 0 ? {} : { title }),
  };
}

export const LIFECYCLE_REVIEW_UNAVAILABLE_REASON =
  "This action needs Auto-review approval, which isn't available in this conversation. Run it from a direct chat with the assistant.";

export function sandCloudAgentLifecycleReason(action: CloudLifecycleAction): string {
  switch (action) {
    case "delete":
      return "Deleting a cloud agent is permanent and cannot be undone, so it needs your approval.";
    case "cancel":
      return "Cancelling a cloud agent's active run stops its work, so it needs your approval.";
    case "archive":
      return "Archiving a cloud agent needs your approval.";
    case "unarchive":
      return "Unarchiving a cloud agent needs your approval.";
    case "rename":
      return "Renaming a cloud agent changes how it appears everywhere, so it needs your approval.";
  }
}

export async function reviewSandCloudAgentLifecycleAction<Context>(args: {
  readonly ctx: Context;
  readonly target: CloudAgentLifecycleReviewTarget;
  readonly options: Pick<CloudAgentReviewOptions<Context>,
    "mode" | "agentId" | "autoReviewController" | "getApprovalExpiryPolicy" | "suspendToolExecutionTimeout">;
  readonly signal?: AbortSignal;
}): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
  const { ctx, target, options } = args;
  if (options.mode !== "enforce") return { allowed: true };
  const cancelled = () => args.signal?.aborted === true;
  if (cancelled()) return CANCELLED_CLOUD_AGENT_REVIEW;
  const controller = options.autoReviewController;
  if (controller == null) return { allowed: false, reason: LIFECYCLE_REVIEW_UNAVAILABLE_REASON };
  const reason = sandCloudAgentLifecycleReason(target.action);
  const request = () => controller.requestApproval({
    agentId: options.agentId,
    surface: "cloud_agent",
    fingerprint: fingerprintSandAutoReviewTarget({
      kind: "cloud_agent_lifecycle",
      action: target.action,
      agentId: target.agentId,
      title: target.title,
    }),
    reason,
    summary: summarizeSandCloudAgentLifecycleAction({
      action: target.action,
      agentId: target.agentId,
      ...(target.title == null ? {} : { title: target.title }),
    }),
    ...(args.signal == null ? {} : { signal: args.signal }),
    ...(options.getApprovalExpiryPolicy == null
      ? {}
      : { expiryPolicy: options.getApprovalExpiryPolicy() }),
  });
  const approval = options.suspendToolExecutionTimeout == null
    ? await request()
    : await options.suspendToolExecutionTimeout(ctx, request);
  if (cancelled()) return CANCELLED_CLOUD_AGENT_REVIEW;
  return approval.approved
    ? { allowed: true }
    : { allowed: false, reason: approval.reason ?? reason };
}
