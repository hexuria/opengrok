import type { AgentToolsGenerator } from "./tools/tools-generator-contract.js";
import type { CursorRule } from "../proto/generated/agent/v1/cursor_rules_pb.js";

/**
 * The normalized AnysphereAgent config fragment consumed by tool generation.
 * This belongs to the Agent config owner, not to an action-handler-local shape.
 */
export interface AgentConfigToolingContract {
  readonly toolsGenerator: AgentToolsGenerator;
  readonly agentSessionId: string | undefined;
  readonly autoRejectFirstAskQuestion: boolean | undefined;
  readonly smartModeClassifierMode: boolean | undefined;
  readonly smartModeClassifierShadowMode: boolean | undefined;
  readonly enableToolArgPreservation: boolean | undefined;
  readonly featureFlags: {
    readonly writeBarrierTimeoutMs?: number | undefined;
    readonly nalLoopDetection?: boolean | undefined;
    readonly dropCustomPromptContext?: boolean | undefined;
    readonly enableHookAdditionalContext?: boolean | undefined;
    readonly enableAgentStoreConflictNotices?: boolean | undefined;
  } | undefined;
  readonly recordAgentStoreWriteBarrier: unknown;
  readonly nonFileRules: readonly CursorRule[];
}
