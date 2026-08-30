import type { MethodInfoUnary } from "@bufbuild/protobuf";
import type { Context } from "../../../packages/context/core.js";
import {
  SmartModeClassifierArgs,
  type SmartModeClassifierResult,
} from "../../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";
import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import {
  ClassifySandAutoReviewRequest,
  type ClassifySandAutoReviewResponse,
} from "../../../packages/proto/generated/aiserver/v1/dashboard_pb.js";
import {
  createSandCursorBackendClient,
  type SandInferenceOptions,
} from "../../../shared/node/cursor-backend/cursor-inference.js";
import {
  smartModeClassifierAttemptIndexKey,
  smartModeClassifierModeKey,
} from "../../../packages/agent/utils/smart-mode-classifier-measurement.js";

export class SandSmartModeClassifierError extends Error {}

export function createSandBackendSmartModeClassifierExecutor(
  options: Omit<SandInferenceOptions, "backendUrl">,
) {
  const service = DashboardService as typeof DashboardService & {
    readonly methods: typeof DashboardService.methods & {
      readonly classifySandAutoReview: MethodInfoUnary<
        ClassifySandAutoReviewRequest,
        ClassifySandAutoReviewResponse
      >;
    };
  };
  const client = createSandCursorBackendClient(service, options);
  return {
    async execute(ctx: Context, args: SmartModeClassifierArgs): Promise<SmartModeClassifierResult> {
      const attemptIndex = ctx.get(smartModeClassifierAttemptIndexKey);
      const mode = ctx.get(smartModeClassifierModeKey) ?? "enforce";
      const response = await client.classifySandAutoReview(
        new ClassifySandAutoReviewRequest({
          // Forward parentConversationId so backend Prompt Quality dumps group
          // with the Sand transcript (same as IDE Smart Mode). Keep toolCallId
          // off the wire — it is host-local measurement telemetry only.
          args: new SmartModeClassifierArgs({
            target: args.target!,
            conversationContext: args.conversationContext,
            parentConversationId: args.parentConversationId!,
          }),
          attemptIndex: attemptIndex!,
          mode,
        }),
        { signal: ctx.signal },
      );
      if (response.result === undefined) {
        throw new SandSmartModeClassifierError("ClassifySandAutoReview returned no result");
      }
      return response.result;
    },
  };
}
