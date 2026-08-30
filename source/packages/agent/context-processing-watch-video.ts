import { BackgroundComposerSource } from "../proto/generated/aiserver/v1/background_composer_pb.js";
import { AgentType } from "./utils/agent-config.js";

export interface WatchVideoEligibilityInput {
  readonly agentType: AgentType | undefined;
  readonly backgroundAgentSource: BackgroundComposerSource | undefined;
  readonly featureFlags?: {
    readonly enableSlackVideoAttachments?: boolean | undefined;
    readonly enableWatchVideoInIdeSubagent?: boolean | undefined;
  } | undefined;
}

// Exact private gate from ../packages/agent/dist/context-processing.js.
export function canUseWatchVideoSubagent({
  agentType,
  backgroundAgentSource,
  featureFlags,
}: WatchVideoEligibilityInput): boolean {
  const backgroundAgentSupportsWatchVideo = agentType === AgentType.BACKGROUND &&
    (backgroundAgentSource === BackgroundComposerSource.SLACK || backgroundAgentSource === BackgroundComposerSource.AUTOMATIONS) &&
    (featureFlags?.enableSlackVideoAttachments ?? false);
  return (agentType === AgentType.IDE && (featureFlags?.enableWatchVideoInIdeSubagent ?? false)) ||
    backgroundAgentSupportsWatchVideo;
}
