import { AgentConversationTurnHandle, type ConversationStateHandle } from "./state.js";
import { buildSimulatedMessagePromptUserContent } from "./simulated-message-prompts.js";
import { fromRedactedUserMessage } from "../redacted-protos/generated/agent/v1/agent_redacted.js";
import { fromRedactedAskQuestionArgs, fromRedactedAskQuestionResult } from "../redacted-protos/generated/agent/v1/ask_question_tool_redacted.js";
import { fromRedactedComputerUseToolCall } from "../redacted-protos/generated/agent/v1/computer_use_tool_redacted.js";
import { fromRedactedCoreMessage } from "../redaction/core-message.js";
import { PrivacyCapability } from "../redaction/classification.js";
import { SimulatedMsgReason } from "../proto/generated/agent/v1/agent_pb.js";
import { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.js";
import { SmartModeClassifierConversationMessage } from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";
import type { Context as OperationContext } from "../context/core.js";

const SMART_MODE_CLASSIFIER_MAX_ASSISTANT_MESSAGES = 2;
const SMART_MODE_CLASSIFIER_MAX_USER_MESSAGES = 2;
const SMART_MODE_CLASSIFIER_MAX_QUESTION_RESULTS = 2;
const SMART_MODE_CLASSIFIER_MAX_QUESTION_STEPS = 50;
const SMART_MODE_CLASSIFIER_MAX_CONTEXT_CHARS = 8e3;
const SAND_AUTO_REVIEW_CLASSIFIER_MAX_ASSISTANT_MESSAGES = 4;
const SAND_AUTO_REVIEW_CLASSIFIER_MAX_USER_MESSAGES = 2;
const SAND_AUTO_REVIEW_CLASSIFIER_MAX_QUESTION_RESULTS = 2;
const SAND_AUTO_REVIEW_CLASSIFIER_MAX_MESSAGE_CHARS = 4e3;
const SAND_AUTO_REVIEW_CLASSIFIER_MESSAGE_TRUNCATION_MARKER = "\n...[auto-review context truncated]...\n";
const SAND_AUTO_REVIEW_CLASSIFIER_MAX_STRUCTURAL_CONTEXT_CHARS = (SAND_AUTO_REVIEW_CLASSIFIER_MAX_USER_MESSAGES + SAND_AUTO_REVIEW_CLASSIFIER_MAX_ASSISTANT_MESSAGES + SAND_AUTO_REVIEW_CLASSIFIER_MAX_QUESTION_RESULTS) * SAND_AUTO_REVIEW_CLASSIFIER_MAX_MESSAGE_CHARS;

const IDE_SMART_MODE_CLASSIFIER_CONTEXT_LIMITS = {
  maxAssistantMessages: SMART_MODE_CLASSIFIER_MAX_ASSISTANT_MESSAGES,
  maxUserMessages: SMART_MODE_CLASSIFIER_MAX_USER_MESSAGES,
  maxQuestionResults: SMART_MODE_CLASSIFIER_MAX_QUESTION_RESULTS,
  maxQuestionSteps: SMART_MODE_CLASSIFIER_MAX_QUESTION_STEPS,
};
const SAND_AUTO_REVIEW_CLASSIFIER_CONTEXT_LIMITS = {
  maxAssistantMessages: SAND_AUTO_REVIEW_CLASSIFIER_MAX_ASSISTANT_MESSAGES,
  maxUserMessages: SAND_AUTO_REVIEW_CLASSIFIER_MAX_USER_MESSAGES,
  maxQuestionResults: SAND_AUTO_REVIEW_CLASSIFIER_MAX_QUESTION_RESULTS,
  maxQuestionSteps: SMART_MODE_CLASSIFIER_MAX_QUESTION_STEPS,
};

type ClassifierStateHandler = Pick<ConversationStateHandle, "turns" | "rootPromptBuilder">;
type ClassifierMessage = { role: string; content: string };

const fromRedactedUserMessageForClassifier = fromRedactedUserMessage as unknown as (message: any, purpose: PrivacyCapability) => any;
const fromRedactedAskQuestionArgsForClassifier = fromRedactedAskQuestionArgs as unknown as (message: any, purpose: PrivacyCapability) => any;
const fromRedactedAskQuestionResultForClassifier = fromRedactedAskQuestionResult as unknown as (message: any, purpose: PrivacyCapability) => any;
const fromRedactedComputerUseToolCallForClassifier = fromRedactedComputerUseToolCall as unknown as (message: any, purpose: PrivacyCapability) => any;

function getAssistantMessageText(step: any): string | undefined {
  if (step.message.case !== "assistantMessage") return undefined;
  const text = step.message.value.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).trim();
  return text.length > 0 ? text : undefined;
}

async function collectRecentAssistantMessages(ctx: OperationContext, stateHandler: ClassifierStateHandler, maxMessages: number): Promise<string[]> {
  const assistantMessagesNewestFirst: string[] = [];
  for (let turnIndex = stateHandler.turns.length - 1; turnIndex >= 0 && assistantMessagesNewestFirst.length < maxMessages; turnIndex--) {
    const turn = await stateHandler.turns[turnIndex]!.get(ctx);
    if (!(turn instanceof AgentConversationTurnHandle)) continue;
    for (let stepIndex = turn.getInnerStructure().steps.length - 1; stepIndex >= 0 && assistantMessagesNewestFirst.length < maxMessages; stepIndex--) {
      const step = await (turn as any).steps[stepIndex].get(ctx) as any;
      const text = getAssistantMessageText(step);
      if (text !== undefined) assistantMessagesNewestFirst.push(text);
    }
  }
  return assistantMessagesNewestFirst.toReversed();
}

function formatComputerUseToolCallForClassifier(toolCall: any): string {
  const description = toolCall.args?.description?.trim();
  const input = {
    ...(description !== undefined && description.length > 0 ? { declared_purpose: description } : {}),
    actions: toolCall.args?.actions.map((action: any) => action.toJson()) ?? [],
  };
  const result = toolCall.result?.result;
  const output = result?.case === "success"
    ? {
        status: "success",
        actionCount: result.value.actionCount,
        durationMs: result.value.durationMs,
        ...(result.value.log === undefined ? {} : { log: result.value.log }),
        ...(result.value.screenshotPath === undefined ? {} : { screenshotPath: result.value.screenshotPath }),
        ...(result.value.cursorPosition === undefined ? {} : { cursorPosition: result.value.cursorPosition.toJson() }),
        screenshotOmitted: result.value.screenshot !== undefined && result.value.screenshot.length > 0,
      }
    : result?.case === "error"
      ? {
          status: "error",
          error: result.value.error,
          actionCount: result.value.actionCount,
          durationMs: result.value.durationMs,
          ...(result.value.log === undefined ? {} : { log: result.value.log }),
          ...(result.value.screenshotPath === undefined ? {} : { screenshotPath: result.value.screenshotPath }),
          screenshotOmitted: result.value.screenshot !== undefined && result.value.screenshot.length > 0,
        }
      : { status: "pending" };
  return `input:\n${JSON.stringify(input)}\noutput:\n${JSON.stringify(output)}`;
}

async function collectCurrentIntentComputerToolCalls(
  ctx: OperationContext,
  stateHandler: ClassifierStateHandler,
  excludedUserMessageTextPrefixes: readonly string[],
  trustedUserMessageTextPrefixes: readonly string[],
): Promise<string[]> {
  if (stateHandler.turns.length === 0) return [];
  let firstIntentTurnIndex = stateHandler.turns.length - 1;
  for (let turnIndex = stateHandler.turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = await stateHandler.turns[turnIndex]!.get(ctx);
    if (!(turn instanceof AgentConversationTurnHandle)) continue;
    const userMessage = await (turn as any).userMessage.get(ctx) as any;
    const text = getUserMessageContextText(userMessage, {
      includeInvokedWorkflowFilesAnnotation: false,
      currentTurnInvokedSkillPaths: [],
      excludedUserMessageTextPrefixes,
      trustedUserMessageTextPrefixes,
    });
    if (text !== undefined) {
      firstIntentTurnIndex = turnIndex;
      break;
    }
  }
  const computerToolCalls: string[] = [];
  for (let turnIndex = firstIntentTurnIndex; turnIndex < stateHandler.turns.length; turnIndex++) {
    const turn = await stateHandler.turns[turnIndex]!.get(ctx);
    if (!(turn instanceof AgentConversationTurnHandle)) continue;
    for (const stepRef of (turn as any).steps) {
      const step = await stepRef.get(ctx) as any;
      if (step.message.case === "toolCall" && step.message.value.tool.case === "computerUseToolCall") {
        computerToolCalls.push(formatComputerUseToolCallForClassifier(fromRedactedComputerUseToolCallForClassifier(step.message.value.tool.value, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)));
      }
    }
  }
  return computerToolCalls;
}

function extractInvokedSkillFilePaths(selectedContext: any): string[] {
  if (selectedContext === undefined) return [];
  const paths = new Set<string>();
  const selectedSkills = selectedContext.selectedSkills ?? [];
  if (selectedSkills.length > 0) {
    for (const skill of selectedSkills) {
      const fullPath = skill.fullPath?.trim();
      if (fullPath !== undefined && fullPath.length > 0) paths.add(fullPath);
    }
    return [...paths];
  }
  return [...paths];
}

function extractInvokedCommandFilePaths(selectedContext: any): string[] {
  if (selectedContext === undefined) return [];
  const paths = new Set<string>();
  for (const command of selectedContext.cursorCommands) {
    const fullPath = command.fullPath?.trim();
    if (fullPath !== undefined && fullPath.length > 0) paths.add(fullPath);
  }
  return [...paths];
}

const INVOKED_SKILLS_OPEN_TAG = '<invoked_skills note="skill files the user explicitly invoked for this request">';
const INVOKED_SKILLS_CLOSE_TAG = "</invoked_skills>";
const INVOKED_COMMANDS_OPEN_TAG = '<invoked_commands note="command files the user explicitly invoked for this request">';
const INVOKED_COMMANDS_CLOSE_TAG = "</invoked_commands>";
const MANUALLY_ATTACHED_SKILLS_CLOSE_TAG = "</manually_attached_skills>";

function extractPathsFromManuallyAttachedSkillsText(text: string): string[] {
  const paths = new Set<string>();
  const blocks = text.match(/<manually_attached_skills>[\s\S]*?<\/manually_attached_skills>/g) ?? [];
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith("Path:")) {
        const fullPath = trimmedLine.slice("Path:".length).trim();
        if (fullPath.length > 0) paths.add(fullPath);
      }
    }
  }
  return [...paths];
}

function getCoreMessageTextParts(message: any): string[] {
  if (typeof message.content === "string") return [message.content];
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part: any) => part.type === "text" ? [part.text] : []);
}

function extractCurrentTurnInvokedSkillPathsFromRootPrompt(stateHandler: ClassifierStateHandler): string[] {
  const paths = new Set<string>();
  const rootPromptMessages = stateHandler.rootPromptBuilder.getState();
  for (let index = rootPromptMessages.length - 1; index >= 0; index--) {
    const redactedMessage = rootPromptMessages[index]!;
    const message = fromRedactedCoreMessage(redactedMessage as any, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    if (message.role !== "user") continue;
    for (const text of getCoreMessageTextParts(message)) {
      for (const path of extractPathsFromManuallyAttachedSkillsText(text)) paths.add(path);
      if (text.includes(MANUALLY_ATTACHED_SKILLS_CLOSE_TAG)) return [...paths];
    }
    return [...paths];
  }
  return [];
}

function withInvokedWorkflowFilesAnnotation(baseText: string | undefined, paths: { skillPaths: readonly string[]; commandPaths: readonly string[] }): string {
  const annotations: string[] = [];
  if (paths.skillPaths.length > 0) annotations.push([INVOKED_SKILLS_OPEN_TAG, ...paths.skillPaths.map(skillPath => `- ${skillPath}`), INVOKED_SKILLS_CLOSE_TAG].join("\n"));
  if (paths.commandPaths.length > 0) annotations.push([INVOKED_COMMANDS_OPEN_TAG, ...paths.commandPaths.map(commandPath => `- ${commandPath}`), INVOKED_COMMANDS_CLOSE_TAG].join("\n"));
  const annotation = annotations.join("\n\n");
  return baseText !== undefined && baseText.length > 0 ? `${annotation}\n\n${baseText}` : annotation;
}

function getUserMessageContextText(userMessage: any, options: {
  includeInvokedWorkflowFilesAnnotation: boolean;
  currentTurnInvokedSkillPaths: readonly string[];
  excludedUserMessageTextPrefixes: readonly string[];
  trustedUserMessageTextPrefixes: readonly string[];
}): string | undefined {
  const plainUserMessage = fromRedactedUserMessageForClassifier(userMessage, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
  const trustedPrefix = options.trustedUserMessageTextPrefixes.find(prefix => plainUserMessage.text.startsWith(prefix));
  if (trustedPrefix === undefined && options.excludedUserMessageTextPrefixes.some(prefix => plainUserMessage.text.startsWith(prefix))) return undefined;
  if (plainUserMessage.simulatedMsgReason === SimulatedMsgReason.BACKGROUND_TASK_COMPLETION || plainUserMessage.simulatedMsgReason === SimulatedMsgReason.GOAL_CONTINUATION) return undefined;
  const rawText = plainUserMessage.text.slice(trustedPrefix?.length ?? 0).trim();
  let baseText = rawText.length > 0 ? rawText : undefined;
  if (plainUserMessage.isSimulatedMsg === true) {
    const simulatedText = buildSimulatedMessagePromptUserContent({
      selectedContext: plainUserMessage.selectedContext ?? new SelectedContext(),
      simulatedMsgReason: plainUserMessage.simulatedMsgReason as SimulatedMsgReason,
    }).map(part => part.text.trim()).filter(text => text.length > 0).join("\n\n").trim();
    if (simulatedText.length > 0) baseText = simulatedText;
  }
  if (!options.includeInvokedWorkflowFilesAnnotation) return baseText;
  const invokedSkillPaths = extractInvokedSkillFilePaths(plainUserMessage.selectedContext);
  const combinedInvokedSkillPaths = [...new Set([...invokedSkillPaths, ...options.currentTurnInvokedSkillPaths])];
  const invokedCommandPaths = extractInvokedCommandFilePaths(plainUserMessage.selectedContext);
  return combinedInvokedSkillPaths.length === 0 && invokedCommandPaths.length === 0 ? baseText : withInvokedWorkflowFilesAnnotation(baseText, { skillPaths: combinedInvokedSkillPaths, commandPaths: invokedCommandPaths });
}

async function collectRecentUserMessages(ctx: OperationContext, stateHandler: ClassifierStateHandler, maxMessages: number, excludedUserMessageTextPrefixes: readonly string[], trustedUserMessageTextPrefixes: readonly string[]): Promise<string[]> {
  const userMessagesNewestFirst: string[] = [];
  let isMostRecentAgentTurn = true;
  const currentTurnInvokedSkillPaths = extractCurrentTurnInvokedSkillPathsFromRootPrompt(stateHandler);
  for (let turnIndex = stateHandler.turns.length - 1; turnIndex >= 0 && userMessagesNewestFirst.length < maxMessages; turnIndex--) {
    const turn = await stateHandler.turns[turnIndex]!.get(ctx);
    if (!(turn instanceof AgentConversationTurnHandle)) continue;
    const userMessage = await (turn as any).userMessage.get(ctx) as any;
    const text = getUserMessageContextText(userMessage, {
      includeInvokedWorkflowFilesAnnotation: isMostRecentAgentTurn,
      currentTurnInvokedSkillPaths: isMostRecentAgentTurn ? currentTurnInvokedSkillPaths : [],
      excludedUserMessageTextPrefixes,
      trustedUserMessageTextPrefixes,
    });
    isMostRecentAgentTurn = false;
    if (text !== undefined) userMessagesNewestFirst.push(text);
  }
  return userMessagesNewestFirst.toReversed();
}

function formatAskQuestionAnswerForClassifier(args: any, result: any): string | undefined {
  if (result?.result.case !== "success") return undefined;
  const questionsById = new Map((args?.questions ?? []).map((question: any) => [question.id, question]));
  const renderedAnswers: string[] = [];
  for (const answer of result.result.value.answers) {
    const question = questionsById.get(answer.questionId) as any;
    const optionLabelsById = new Map((question?.options ?? []).map((option: any) => [option.id, option.label]));
    const answerParts = answer.selectedOptionIds.map((optionId: string) => optionLabelsById.get(optionId) ?? optionId);
    const freeformText = answer.freeformText?.trim();
    if (freeformText !== undefined && freeformText.length > 0) answerParts.push(freeformText);
    if (answerParts.length === 0) continue;
    const prompt = question?.prompt.trim();
    const answerText = answerParts.join(", ");
    renderedAnswers.push(prompt !== undefined && prompt.length > 0 ? `Q: ${prompt}\nA: ${answerText}` : `A: ${answerText}`);
  }
  return renderedAnswers.length > 0 ? renderedAnswers.join("\n\n") : undefined;
}

async function collectRecentAskQuestionAnswers(ctx: OperationContext, stateHandler: ClassifierStateHandler, maxResults: number, maxSteps: number): Promise<string[]> {
  const currentTurnRef = stateHandler.turns.at(-1);
  if (!currentTurnRef) return [];
  const currentTurn = await currentTurnRef.get(ctx);
  if (!(currentTurn instanceof AgentConversationTurnHandle)) return [];
  const answersNewestFirst: string[] = [];
  let stepsScanned = 0;
  for (let stepIndex = (currentTurn as any).steps.length - 1; stepIndex >= 0 && stepsScanned < maxSteps && answersNewestFirst.length < maxResults; stepIndex--) {
    stepsScanned++;
    const step = await (currentTurn as any).steps[stepIndex].get(ctx) as any;
    if (step.message.case !== "toolCall" || step.message.value.tool.case !== "askQuestionToolCall") continue;
    const askQuestion = step.message.value.tool.value;
    const args = askQuestion.args !== undefined ? fromRedactedAskQuestionArgsForClassifier(askQuestion.args, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : undefined;
    const result = askQuestion.result !== undefined ? fromRedactedAskQuestionResultForClassifier(askQuestion.result, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : undefined;
    const rendered = formatAskQuestionAnswerForClassifier(args, result);
    if (rendered !== undefined) answersNewestFirst.push(rendered);
  }
  return answersNewestFirst.toReversed();
}

function truncateSandAutoReviewClassifierMessageContent(content: string, maxChars = SAND_AUTO_REVIEW_CLASSIFIER_MAX_MESSAGE_CHARS): string {
  if (content.length <= maxChars) return content;
  const marker = SAND_AUTO_REVIEW_CLASSIFIER_MESSAGE_TRUNCATION_MARKER;
  const textBudget = maxChars - marker.length;
  if (textBudget <= 0) return content.slice(0, maxChars);
  const headChars = Math.ceil(textBudget / 2);
  const tailChars = Math.floor(textBudget / 2);
  return `${content.slice(0, headChars)}${marker}${content.slice(-tailChars)}`;
}

function applySmartModeClassifierMessageCountLimits(messages: ClassifierMessage[], limits: { maxAssistantMessages: number; maxUserMessages: number; maxQuestionResults: number }): ClassifierMessage[] {
  const assistantMessages = messages.filter(message => message.role === "assistant").slice(-limits.maxAssistantMessages);
  const userMessages = messages.filter(message => message.role === "user").slice(-limits.maxUserMessages);
  const questionMessages = messages.filter(message => message.role === "user_answer").slice(-limits.maxQuestionResults);
  const computerMessages = messages.filter(message => message.role === "computer");
  const includedAssistantMessages = new Set(assistantMessages);
  const includedUserMessages = new Set(userMessages);
  const includedQuestionMessages = new Set(questionMessages);
  const includedComputerMessages = new Set(computerMessages);
  return messages.flatMap(message => {
    const included = message.role === "assistant" ? includedAssistantMessages.has(message) : message.role === "user_answer" ? includedQuestionMessages.has(message) : message.role === "computer" ? includedComputerMessages.has(message) : includedUserMessages.has(message);
    return included ? [message] : [];
  });
}

function truncateSandAutoReviewClassifierContext(messages: ClassifierMessage[], options: { limits?: typeof SAND_AUTO_REVIEW_CLASSIFIER_CONTEXT_LIMITS; maxCharsPerMessage?: number } = {}): ClassifierMessage[] {
  const limits = options.limits ?? SAND_AUTO_REVIEW_CLASSIFIER_CONTEXT_LIMITS;
  const maxCharsPerMessage = options.maxCharsPerMessage ?? SAND_AUTO_REVIEW_CLASSIFIER_MAX_MESSAGE_CHARS;
  return applySmartModeClassifierMessageCountLimits(messages, limits).map(message => ({ ...message, content: truncateSandAutoReviewClassifierMessageContent(message.content, maxCharsPerMessage) })).filter(message => message.content.length > 0);
}

function truncateSmartModeClassifierContext(messages: ClassifierMessage[], options: { maxChars: number; maxAssistantMessages: number; maxUserMessages: number; maxQuestionMessages: number } = { maxChars: SMART_MODE_CLASSIFIER_MAX_CONTEXT_CHARS, maxAssistantMessages: SMART_MODE_CLASSIFIER_MAX_ASSISTANT_MESSAGES, maxUserMessages: SMART_MODE_CLASSIFIER_MAX_USER_MESSAGES, maxQuestionMessages: SMART_MODE_CLASSIFIER_MAX_QUESTION_RESULTS }): ClassifierMessage[] {
  const maxQuestionMessages = options.maxQuestionMessages ?? SMART_MODE_CLASSIFIER_MAX_QUESTION_RESULTS;
  let assistantMessages = messages.filter(message => message.role === "assistant").slice(-options.maxAssistantMessages);
  let userMessages = messages.filter(message => message.role === "user").slice(-options.maxUserMessages);
  let questionMessages = messages.filter(message => message.role === "user_answer").slice(-maxQuestionMessages);
  let computerMessages = messages.filter(message => message.role === "computer");
  const contentOverrides = new Map<ClassifierMessage, string>();
  const buildMessages = (): ClassifierMessage[] => {
    const includedAssistantMessages = new Set(assistantMessages);
    const includedUserMessages = new Set(userMessages);
    const includedQuestionMessages = new Set(questionMessages);
    const includedComputerMessages = new Set(computerMessages);
    return messages.flatMap(message => {
      const included = message.role === "assistant" ? includedAssistantMessages.has(message) : message.role === "user_answer" ? includedQuestionMessages.has(message) : message.role === "computer" ? includedComputerMessages.has(message) : includedUserMessages.has(message);
      return included ? [{ ...message, content: contentOverrides.get(message) ?? message.content }] : [];
    });
  };
  let result = buildMessages();
  const totalChars = (items: ClassifierMessage[]): number => items.reduce((sum, message) => sum + message.content.length, 0);
  while (totalChars(result) > options.maxChars && assistantMessages.length > 1) { assistantMessages = assistantMessages.slice(1); result = buildMessages(); }
  while (totalChars(result) > options.maxChars && computerMessages.length > 1) { computerMessages = computerMessages.slice(1); result = buildMessages(); }
  while (totalChars(result) > options.maxChars && questionMessages.length > 1) { questionMessages = questionMessages.slice(1); result = buildMessages(); }
  while (totalChars(result) > options.maxChars && userMessages.length > 1) { userMessages = userMessages.slice(1); result = buildMessages(); }
  if (totalChars(result) > options.maxChars) {
    let remaining = options.maxChars;
    for (const message of [...userMessages, ...questionMessages, ...computerMessages, ...assistantMessages]) {
      if (remaining <= 0) { contentOverrides.set(message, ""); continue; }
      const content = message.content.length <= remaining ? message.content : message.content.slice(0, remaining);
      remaining -= content.length;
      contentOverrides.set(message, content);
    }
    result = buildMessages();
  }
  return result.filter(message => message.content.length > 0);
}

async function extractSmartModeClassifierConversationContext(ctx: OperationContext, stateHandler: ClassifierStateHandler, limits = IDE_SMART_MODE_CLASSIFIER_CONTEXT_LIMITS, truncateMessages = (messages: ClassifierMessage[]) => truncateSmartModeClassifierContext(messages), options?: { excludedUserMessageTextPrefixes?: readonly string[]; trustedUserMessageTextPrefixes?: readonly string[]; includeComputerToolCalls?: boolean }): Promise<any[]> {
  const [assistantMessages, userMessages, questionAnswers, computerToolCalls] = await Promise.all([
    collectRecentAssistantMessages(ctx, stateHandler, limits.maxAssistantMessages),
    collectRecentUserMessages(ctx, stateHandler, limits.maxUserMessages, options?.excludedUserMessageTextPrefixes ?? [], options?.trustedUserMessageTextPrefixes ?? []),
    collectRecentAskQuestionAnswers(ctx, stateHandler, limits.maxQuestionResults, limits.maxQuestionSteps),
    options?.includeComputerToolCalls === true ? collectCurrentIntentComputerToolCalls(ctx, stateHandler, options.excludedUserMessageTextPrefixes ?? [], options.trustedUserMessageTextPrefixes ?? []) : [],
  ]);
  const messages: ClassifierMessage[] = [
    ...assistantMessages.map(content => ({ role: "assistant", content })),
    ...userMessages.map(content => ({ role: "user", content })),
    ...questionAnswers.map(content => ({ role: "user_answer", content })),
    ...computerToolCalls.map(content => ({ role: "computer", content })),
  ];
  return truncateMessages(messages).map(message => new SmartModeClassifierConversationMessage({ role: message.role, content: message.content }));
}

async function extractSandAutoReviewClassifierConversationContext(ctx: OperationContext, stateHandler: ClassifierStateHandler, options: { excludedUserMessageTextPrefixes?: readonly string[]; trustedUserMessageTextPrefixes?: readonly string[] } = {}): Promise<any[]> {
  return extractSmartModeClassifierConversationContext(ctx, stateHandler, SAND_AUTO_REVIEW_CLASSIFIER_CONTEXT_LIMITS, truncateSandAutoReviewClassifierContext, { ...options, includeComputerToolCalls: true });
}

export async function tryExtractSmartModeClassifierConversationContext(ctx: OperationContext, stateHandler: ClassifierStateHandler): Promise<any[]> {
  try { return await extractSmartModeClassifierConversationContext(ctx, stateHandler); } catch { return []; }
}

export async function tryExtractSandAutoReviewClassifierConversationContext(ctx: OperationContext, stateHandler: ClassifierStateHandler, options?: { excludedUserMessageTextPrefixes?: readonly string[]; trustedUserMessageTextPrefixes?: readonly string[] }): Promise<any[]> {
  try { return await extractSandAutoReviewClassifierConversationContext(ctx, stateHandler, options); } catch { return []; }
}
