import { createLogger } from "../context/index.js";
import { AgentMode } from "../proto/generated/agent/v1/agent_pb.js";
import { isWorktreesPath } from "../utils/path-utils.js";
import { buildAntiAskQuestionSystemReminder } from "./prompts/anti-ask-question-copy.js";
import { SwitchModeReminderSnippet } from "./prompts/deprecated-do-not-use/shared.js";
import { usesGptPersistenceInstructions, type GptModelInfo } from "./prompts/gpt-helpers.js";
import {
  renderMultitaskModeEnterUserReminderInner,
  renderMultitaskModeExitUserReminder,
  renderStillInMultitaskModeReminder,
  type MultitaskModelInfo,
} from "./prompts/multitask-mode-user-reminder.js";
import { CURSOR_WORKTREE_NOTE } from "./prompts/user-info.js";
import { getTaskToolName, type TaskToolModelInfo } from "./tools/task-tool-name.js";
import { AgentType } from "./utils/agent-config.js";

type ModeModelInfo = TaskToolModelInfo & GptModelInfo & MultitaskModelInfo;

export interface ModeProcessingRequestContext {
  readonly debugModeConfig?: unknown;
  readonly [key: string]: unknown;
}

export interface ModeProcessingConfig {
  readonly planSystemReminderGenerator: (previousMode: AgentMode | undefined) => string;
  readonly askSystemReminderGenerator: (options: {
    readonly prevTurnMode: AgentMode | undefined;
    readonly requestContext: ModeProcessingRequestContext;
  }) => string;
  readonly debugSystemReminderGenerator: (
    debugModeConfig: unknown,
    enteringDebugMode: boolean,
  ) => string;
  readonly triageSystemReminderGenerator: (previousMode: AgentMode | undefined) => string;
  readonly projectSystemReminderGenerator?: ((previousMode: AgentMode | undefined) => string) | undefined;
  readonly modelInfo?: ModeModelInfo | undefined;
  readonly featureFlags?: {
    readonly hideAsyncSubagentTaskNotifications?: boolean | undefined;
    readonly enableAntiAskQuestionSysReminder?: boolean | undefined;
    readonly dropCustomPromptContext?: boolean | undefined;
  } | undefined;
  readonly switchModeToolConfig?: {
    readonly targetModes?: unknown;
    readonly fromModes?: unknown;
  } | undefined;
  readonly userInfoDisplayOptions?: {
    readonly disable?: boolean | undefined;
    readonly displayCursorRules?: boolean | undefined;
  } | undefined;
  readonly askQuestionToolName?: string | undefined;
}

createLogger("@anysphere/agent:mode-processing");

function agentModeToModeId(mode: AgentMode): string {
  switch (mode) {
    case AgentMode.AGENT: return "agent";
    case AgentMode.ASK: return "chat";
    case AgentMode.PLAN: return "plan";
    case AgentMode.DEBUG: return "debug";
    case AgentMode.TRIAGE: return "triage";
    case AgentMode.PROJECT: return "project";
    case AgentMode.MULTITASK: return "multitask";
    default: return "agent";
  }
}

export function resolveCurrentTurnMode(
  persistedMode: AgentMode | undefined,
  userMessageMode: AgentMode | undefined,
): AgentMode {
  if (userMessageMode !== undefined && userMessageMode !== AgentMode.UNSPECIFIED) {
    return userMessageMode;
  }
  if (persistedMode !== undefined && persistedMode !== AgentMode.UNSPECIFIED) {
    return persistedMode;
  }
  return AgentMode.AGENT;
}

export function resolveCurrentStepMode(
  persistedMode: AgentMode | undefined,
  userMessageMode: AgentMode | undefined,
): AgentMode {
  if (persistedMode !== undefined && persistedMode !== AgentMode.UNSPECIFIED) {
    return persistedMode;
  }
  return resolveCurrentTurnMode(persistedMode, userMessageMode);
}

export function processModeSystemReminder(
  mode: AgentMode,
  config: ModeProcessingConfig,
  requestContext: ModeProcessingRequestContext,
  previousMode?: AgentMode,
  options?: { readonly isUserTurn?: boolean | undefined },
): string {
  const isUserTurn = options?.isUserTurn ?? true;
  const hasModeSwitch = previousMode !== undefined && previousMode !== mode;
  const leftMultitask = previousMode !== undefined &&
    previousMode !== AgentMode.UNSPECIFIED &&
    previousMode === AgentMode.MULTITASK &&
    mode !== AgentMode.MULTITASK;
  const exitMultitaskReminder = leftMultitask ? renderMultitaskModeExitUserReminder() : "";
  let modeReminder = "";
  switch (mode) {
    case AgentMode.AGENT:
    case AgentMode.UNSPECIFIED:
      break;
    case AgentMode.PLAN:
      modeReminder = config.planSystemReminderGenerator(previousMode);
      break;
    case AgentMode.ASK:
      modeReminder = config.askSystemReminderGenerator({
        prevTurnMode: previousMode,
        requestContext,
      });
      break;
    case AgentMode.DEBUG:
      modeReminder = config.debugSystemReminderGenerator(
        requestContext.debugModeConfig,
        previousMode !== AgentMode.DEBUG,
      );
      break;
    case AgentMode.TRIAGE:
      modeReminder = config.triageSystemReminderGenerator(previousMode);
      break;
    case AgentMode.PROJECT:
      modeReminder = config.projectSystemReminderGenerator
        ? config.projectSystemReminderGenerator(previousMode)
        : "";
      break;
    case AgentMode.MULTITASK: {
      if (!isUserTurn) break;
      if (previousMode === AgentMode.MULTITASK) {
        modeReminder = renderStillInMultitaskModeReminder({
          modelInfo: config.modelInfo,
          hideAsyncSubagentTaskNotifications:
            config.featureFlags?.hideAsyncSubagentTaskNotifications,
        });
        break;
      }
      const subagentToolName = config.modelInfo !== undefined
        ? getTaskToolName(config.modelInfo)
        : "Task";
      const multitaskReminderInner = renderMultitaskModeEnterUserReminderInner(
        subagentToolName,
        {
          ignoreGptPersistenceInstructions: usesGptPersistenceInstructions(config.modelInfo),
          modelInfo: config.modelInfo,
          hideAsyncSubagentTaskNotifications:
            config.featureFlags?.hideAsyncSubagentTaskNotifications,
        },
      );
      modeReminder = `<system_reminder>\n${multitaskReminderInner}\n</system_reminder>`;
      break;
    }
    default:
      break;
  }
  const trailingModeReminders = [exitMultitaskReminder, modeReminder]
    .filter(Boolean)
    .join("\n\n");
  if (hasModeSwitch) {
    const switchModeReminder = SwitchModeReminderSnippet({
      currentMode: agentModeToModeId(mode),
      targetModes: config.switchModeToolConfig?.targetModes,
      fromModes: config.switchModeToolConfig?.fromModes,
    });
    return trailingModeReminders
      ? `${switchModeReminder}\n\n${trailingModeReminders}`
      : switchModeReminder;
  }
  return trailingModeReminders;
}

export function joinUserTurnSystemReminders(...reminders: string[]): string {
  return reminders.filter(Boolean).join("\n\n");
}

export function processAntiAskQuestionSystemReminder(config: ModeProcessingConfig): string {
  if (
    config.featureFlags?.enableAntiAskQuestionSysReminder !== true ||
    config.featureFlags?.dropCustomPromptContext === true ||
    config.userInfoDisplayOptions?.disable === true ||
    config.userInfoDisplayOptions?.displayCursorRules === false
  ) {
    return "";
  }
  const askQuestionToolName = config.askQuestionToolName ?? "AskQuestion";
  return buildAntiAskQuestionSystemReminder(askQuestionToolName);
}

function normalizeWorkspaceUris(workspaceUris: readonly string[]): string[] {
  const trimmedUris = workspaceUris.map(uri => uri.trim()).filter(uri => uri.length > 0);
  return trimmedUris.slice().sort((a, b) => a.localeCompare(b));
}

function formatWorkspaceUriList(workspaceUris: readonly string[]): string {
  if (workspaceUris.length === 0) return "none";
  return workspaceUris.join(", ");
}

function buildAgentEnvironmentTransitionReminder(
  currentAgentType: AgentType | undefined,
  previousAgentType: AgentType | undefined,
): string {
  if (
    previousAgentType === AgentType.BACKGROUND &&
    currentAgentType !== undefined &&
    currentAgentType !== AgentType.BACKGROUND
  ) {
    return "\n\nYou are now operating as an agent locally on the user's machine. Git commit and push commands should be carried out only when requested by the user (or as required by user rules / skills).";
  }
  if (
    currentAgentType === AgentType.BACKGROUND &&
    previousAgentType !== undefined &&
    previousAgentType !== AgentType.BACKGROUND
  ) {
    return "\n\nYou are now operating as a cloud agent on a remote machine. Manage your own Git state according to your Git instructions.";
  }
  return "";
}

export function processWorkspaceChangeReminder(
  _ctx: unknown,
  currentWorkspaceUris: readonly string[],
  previousWorkspaceUris: readonly string[] | undefined,
  currentAgentType: AgentType | undefined,
  previousAgentType: AgentType | undefined,
): string {
  if (previousWorkspaceUris === undefined) return "";
  const normalizedPrevious = normalizeWorkspaceUris(previousWorkspaceUris);
  const normalizedCurrent = normalizeWorkspaceUris(currentWorkspaceUris);
  if (
    normalizedPrevious.length === normalizedCurrent.length &&
    normalizedPrevious.every((value, index) => value === normalizedCurrent[index])
  ) {
    return "";
  }
  let worktreeNote = "";
  if (normalizedCurrent.length === 1 && isWorktreesPath(normalizedCurrent[0]!)) {
    worktreeNote = ` ${CURSOR_WORKTREE_NOTE}`;
  } else {
    worktreeNote =
      " Your workspace path has changed, and all future edits should be performed in the new workspace folders.";
  }
  const agentEnvironmentTransitionReminder = buildAgentEnvironmentTransitionReminder(
    currentAgentType,
    previousAgentType,
  );
  return `<system_reminder>\nWorkspace folders changed from ${formatWorkspaceUriList(normalizedPrevious)} to ${formatWorkspaceUriList(normalizedCurrent)}.${worktreeNote}${agentEnvironmentTransitionReminder}\n</system_reminder>`;
}
