import { createKey, type Context } from "../../context/index.js";
import { createCounter } from "../../metrics/index.js";

interface SkillAppliedEvent {
  readonly skillId: string;
  readonly skillSource: string;
  readonly entrypoint: string;
  readonly plugin?: string | undefined;
  readonly marketplace?: string | undefined;
  readonly pluginId?: string | undefined;
  readonly marketplaceId?: string | undefined;
}

interface AgentEventTracker {
  trackUnfinishedTodos(...args: unknown[]): void;
  trackUnfinishedTodosWhenCreatedTodos(...args: unknown[]): void;
  trackUnfinishedTodosWhenHadUnfinishedTodosAtStart(...args: unknown[]): void;
  trackSummarizationTriggered(...args: unknown[]): void;
  trackSummarizationPersistedForQualityGrading?(...args: unknown[]): void;
  trackPromptTokens(...args: unknown[]): void;
  trackNumberOfToolCalls(...args: unknown[]): void;
  trackToolCallStarted(...args: unknown[]): void;
  trackToolCallResult(...args: unknown[]): void;
  trackComputerUseExecution(...args: unknown[]): void;
  trackLoopDetected(...args: unknown[]): void;
  trackSubagentCreated(...args: unknown[]): void;
  trackSubagentCompleted(...args: unknown[]): void;
  trackShellSandboxResult(...args: unknown[]): void;
  trackSkillUsed(...args: unknown[]): void;
  trackSkillApplied(context: Context, event: SkillAppliedEvent): void;
  trackHookExecuted(...args: unknown[]): void;
  trackSmartModeClassifierCall(...args: unknown[]): void;
  trackPlanModeModelFinished(...args: unknown[]): void;
  trackMcpToolCall(...args: unknown[]): void;
  trackMcpToolCallResult(...args: unknown[]): void;
}

interface RecordSkillAppliedInput extends SkillAppliedEvent {
  readonly stateHandler?: {
    readonly lastSkillCatalogBudgetStrategy?: string;
  };
}

const skillApplied = createCounter("skill.applied", {
  description: "Skill applications (e.g. SKILL.md reads), tagged by the catalog truncation that ran for the current turn, the skill source, and the entrypoint that triggered the application",
  labelNames: ["truncation", "skill_source", "entrypoint"],
});

function skillCatalogBudgetStrategyToTruncation(strategy: string | undefined): string {
  if (strategy === undefined) {
    return "none";
  }
  return strategy;
}

const agentEventTrackerKey = createKey<AgentEventTracker>(Symbol("agentEventTracker"), {
  trackUnfinishedTodos: () => {},
  trackUnfinishedTodosWhenCreatedTodos: () => {},
  trackUnfinishedTodosWhenHadUnfinishedTodosAtStart: () => {},
  trackSummarizationTriggered: () => {},
  trackPromptTokens: () => {},
  trackNumberOfToolCalls: () => {},
  trackToolCallStarted: () => {},
  trackToolCallResult: () => {},
  trackComputerUseExecution: () => {},
  trackLoopDetected: () => {},
  trackSubagentCreated: () => {},
  trackSubagentCompleted: () => {},
  trackShellSandboxResult: () => {},
  trackSkillUsed: () => {},
  trackSkillApplied: () => {},
  trackHookExecuted: () => {},
  trackSmartModeClassifierCall: () => {},
  trackPlanModeModelFinished: () => {},
  trackMcpToolCall: () => {},
  trackMcpToolCallResult: () => {},
});

export const getAgentEventTracker = (context: Context): AgentEventTracker => {
  return context.get(agentEventTrackerKey);
};

export function recordSkillApplied(context: Context, input: RecordSkillAppliedInput): void {
  const truncation = input.entrypoint === "manually_attached"
    ? "bypassed"
    : skillCatalogBudgetStrategyToTruncation(input.stateHandler?.lastSkillCatalogBudgetStrategy);
  const tracker = getAgentEventTracker(context);
  tracker.trackSkillApplied(context, {
    skillId: input.skillId,
    skillSource: input.skillSource,
    entrypoint: input.entrypoint,
    plugin: input.plugin,
    marketplace: input.marketplace,
    pluginId: input.pluginId,
    marketplaceId: input.marketplaceId,
  });
  skillApplied.increment(context, 1, {
    truncation,
    skill_source: input.skillSource,
    entrypoint: input.entrypoint,
  });
}
