import type { RequestContext } from "../../proto/generated/agent/v1/request_context_exec_pb.js";
import { AgentType } from "../utils/agent-config.js";
import {
  createDevSmartModeClassifierBlockState,
  createDevSmartModeClassifierDelayState,
  type OneShotState,
} from "./dev-smart-mode-classifier-block.js";

export interface SmartModeClassifierRuntimeState {
  readonly autoModeSelected: boolean;
  readonly enabled: boolean;
  readonly shadowEnabled: boolean;
  readonly devBlockState: OneShotState | undefined;
  readonly devDelayState: OneShotState | undefined;
}

export function getSmartModeClassifierRuntimeState({
  agentType,
  requestContext,
  smartModeClassifierMode,
  smartModeClassifierShadowMode,
  devBlockState,
  devDelayState,
}: {
  readonly agentType: AgentType;
  readonly requestContext?: Pick<RequestContext, "env"> | undefined;
  readonly smartModeClassifierMode: boolean;
  readonly smartModeClassifierShadowMode: boolean;
  readonly devBlockState?: OneShotState | undefined;
  readonly devDelayState?: OneShotState | undefined;
}): SmartModeClassifierRuntimeState {
  const isBackgroundAgent = agentType === AgentType.BACKGROUND;
  const autoModeSelected = smartModeClassifierMode === true && requestContext?.env?.smartModeClassifierAutoModeEnabled === true;
  const enabled = !isBackgroundAgent && autoModeSelected;
  return {
    autoModeSelected,
    enabled,
    shadowEnabled: !isBackgroundAgent && !enabled && smartModeClassifierShadowMode === true,
    devBlockState: devBlockState ?? createDevSmartModeClassifierBlockState(requestContext),
    devDelayState: devDelayState ?? createDevSmartModeClassifierDelayState(requestContext),
  };
}
