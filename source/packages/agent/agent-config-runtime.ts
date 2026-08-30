import { DISABLED_BACKGROUND_SUMMARIZATION_PROPS } from "../agent-summarization/background-summarization.js";
import { MAX_AGENT_STEPS } from "./constants.js";
import { filterByActorIdentity } from "./utils/scoped-rule-filtering.js";

type Any = any;

/**
 * The constructor-owned defaults from the shipped AnysphereAgent class.
 * Keep this projection internal to the package root; it is not a replacement
 * for the broader generated/config contract used by action handlers.
 */
export function normalizeAnysphereAgentConfig(config: Any): Any {
  if (config.systemPromptGenerator === undefined) {
    throw new Error("systemPromptGenerator is required");
  }

  const normalized = {
    planSystemReminderGenerator: () => "",
    askSystemReminderGenerator: (_options: Any) => "",
    debugSystemReminderGenerator: (_debugModeConfig: Any, _isFirstDebugModeMessage: Any) => "",
    triageSystemReminderGenerator: () => "",
    projectSystemReminderGenerator: () => "",
    backgroundSummarizationProps: DISABLED_BACKGROUND_SUMMARIZATION_PROPS,
    formattingOptions: {
      shouldUseFormatCodeblock: true,
      gpt5StyleLineNumbers: false,
      gpt5CodexCatN: false,
    },
    nonFileRules: [],
    immediatelyUpdateStateOnNewTurn: false,
    smartModeClassifierMode: false,
    smartModeClassifierShadowMode: false,
    doNotFailOnMaxSteps: false,
    enableAgentNotes: false,
    enableTerminalFiles: true,
    enableImageFiles: false,
    enableLongCodeSelectionSpillToFile: true,
    enableToolArgPreservation: true,
    strictArgParsing: false,
    enableExecuteHookExec: false,
    enableTranscriptInSummary: true,
    summarizeActionClearTurns: false,
    fireAndForgetCheckpoints: false,
    skipErrorStateCheckpoint: false,
    enablePrependedUserActions: true,
    ...config,
    maxSteps: config.maxSteps ?? MAX_AGENT_STEPS,
  };

  normalized.nonFileRules = filterByActorIdentity(
    normalized.nonFileRules,
    normalized.actorIdentity,
  );
  return normalized;
}
