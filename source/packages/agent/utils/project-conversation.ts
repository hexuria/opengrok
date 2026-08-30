import { isRootProjectDetails } from "../../constants/project-conversation.js";
import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.js";
import { AgentType } from "./agent-config.js";
import type { Context } from "../../context/core.js";

interface ProjectUserMessage {
  readonly projectDetails?: Parameters<typeof isRootProjectDetails>[0];
  readonly bestOfNGroupId?: unknown;
  readonly mode?: AgentMode;
  readonly isSimulatedMsg?: boolean;
}

interface ProjectConversationTurn {
  get(ctx: Context): Promise<{
    readonly userMessage?: { get(ctx: Context): Promise<ProjectUserMessage> };
    readonly [key: string]: unknown;
  }>;
}

interface ProjectConversationState {
  readonly turns: readonly ProjectConversationTurn[];
}

export function isRootProjectUserMessage(userMessage: ProjectUserMessage): boolean {
  return isRootProjectDetails(userMessage.projectDetails) && userMessage.bestOfNGroupId === undefined;
}

export function shouldOmitCloudWorkerProcedure({
  gateEnabled,
  agentType,
  mode,
  useLocalAgentPrompting,
  isNamedAgentSession,
  isRootProject,
}: {
  readonly gateEnabled: boolean;
  readonly agentType: AgentType;
  readonly mode: AgentMode;
  readonly useLocalAgentPrompting: boolean;
  readonly isNamedAgentSession: boolean;
  readonly isRootProject: boolean;
}): boolean {
  return gateEnabled &&
    agentType === AgentType.BACKGROUND &&
    mode === AgentMode.AGENT &&
    !useLocalAgentPrompting &&
    !isNamedAgentSession &&
    isRootProject;
}

export async function resolveProjectConversationContext(
  ctx: Context,
  stateHandler: ProjectConversationState,
): Promise<{
  lastMode: AgentMode | undefined;
  isRootProject: boolean;
  hasProjectBoundary: boolean;
}> {
  let lastMode: AgentMode | undefined;
  for (let index = stateHandler.turns.length - 1; index >= 0; index--) {
    const turn = await stateHandler.turns[index]!.get(ctx);
    if (!("userMessage" in turn)) continue;
    const userMessage = await turn.userMessage!.get(ctx);
    lastMode ??= userMessage.mode;
    const hasProjectBoundary =
      userMessage.projectDetails !== undefined || userMessage.bestOfNGroupId !== undefined;
    if (hasProjectBoundary) {
      return {
        lastMode,
        isRootProject: isRootProjectUserMessage(userMessage),
        hasProjectBoundary: true,
      };
    }
    if (userMessage.isSimulatedMsg !== true) break;
  }
  return { lastMode, isRootProject: false, hasProjectBoundary: false };
}
