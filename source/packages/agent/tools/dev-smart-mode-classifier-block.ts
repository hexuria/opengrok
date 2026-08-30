import type { RequestContext } from "../../proto/generated/agent/v1/request_context_exec_pb.js";
import { DEV_SMART_MODE_CLASSIFIER_DELAY_MS } from "../../constants/smart-mode-classifier.js";
import { delay } from "../../utils/promise-extras.js";

export const DEV_SMART_MODE_CLASSIFIER_BLOCK_REASON = "This is a dev block whatever just retry it";

export interface OneShotState {
  consume(): boolean;
}

function createDevSmartModeClassifierOneShotState(token: string | undefined): OneShotState | undefined {
  const trimmedToken = token?.trim();
  if (trimmedToken === undefined || trimmedToken.length === 0) return undefined;
  let consumed = false;
  return {
    consume(): boolean {
      if (consumed) return false;
      consumed = true;
      return true;
    },
  };
}

function getDevSmartModeClassifierEnv(requestContext: Pick<RequestContext, "env"> | undefined): RequestContext["env"] {
  if (typeof process === "undefined" || process.env.NODE_ENV !== "development") return undefined;
  return requestContext?.env;
}

export function createDevSmartModeClassifierBlockState(
  requestContext: Pick<RequestContext, "env"> | undefined,
): OneShotState | undefined {
  return createDevSmartModeClassifierOneShotState(getDevSmartModeClassifierEnv(requestContext)?.devForceNextSmartModeClassifierBlockToken);
}

export function createDevSmartModeClassifierDelayState(
  requestContext: Pick<RequestContext, "env"> | undefined,
): OneShotState | undefined {
  return createDevSmartModeClassifierOneShotState(getDevSmartModeClassifierEnv(requestContext)?.devDelayNextSmartModeClassifierToken);
}

export async function delayDevSmartModeClassifierIfRequested(state: OneShotState | undefined): Promise<void> {
  const consumed = state?.consume() === true;
  if (consumed) await delay(DEV_SMART_MODE_CLASSIFIER_DELAY_MS);
}
