import { z } from "zod";

import { isAskQuestionAutoAnswerReason } from "../../../../constants/ask-question.js";
import type { AskQuestionResult } from "../../../../proto/generated/agent/v1/ask_question_tool_pb.js";

const FIRST_ASK_QUESTION_CLIENT_ERROR_MESSAGE = "Tool call failed";
const FIRST_ASK_QUESTION_MODEL_ERROR_MESSAGE =
  "Rejected: you must research first (codebase, filesystem, and other tools) before asking the user. Do not use this tool to inquire into details, solicit feedback on suggestions, or ask for confirmations. Only call this again if you absolutely need user input (i.e. you are doing some destructive action, making a major architectural decision, or the user requested it in their workflow). Don't mention this to the user.";

export function shouldReceiptAskQuestionResult(
  result: AskQuestionResult | undefined,
): boolean {
  if (result === undefined) {
    return false;
  }
  const resultCase = result.result.case;
  if (resultCase === "success" || resultCase === "error") {
    return true;
  }
  if (resultCase === "rejected") {
    return !isAskQuestionAutoAnswerReason(result.result.value.reason);
  }
  return false;
}

const questionSchema = z.object({
  id: z.string().describe("Unique identifier for this question"),
  prompt: z.string().describe("The question text to display to the user, without the options."),
  options: z.array(z.object({
    id: z.string().describe("Unique identifier for this option"),
    label: z.string().describe("Display text for this option"),
  })).min(2).describe("Array of answer options (minimum 2 required)"),
  allow_multiple: z.boolean().optional().describe(
    "If true, user can select multiple options. Defaults to false.",
  ),
});
void questionSchema;

export function formatAskQuestionResultAsString(result: AskQuestionResult): string {
  switch (result.result.case) {
    case "success": {
      const answerDescriptions = result.result.value.answers.map(answer => {
        const hasSelectedOptions = answer.selectedOptionIds.length > 0;
        const freeformText = answer.freeformText?.trim();
        const hasFreeformText = freeformText && freeformText.length > 0;
        if (hasSelectedOptions && hasFreeformText) {
          return `Question ${answer.questionId}: Selected option(s) ${answer.selectedOptionIds.join(", ")}, freeform: ${freeformText}`;
        }
        if (hasFreeformText) {
          return `Question ${answer.questionId}: ${freeformText}`;
        }
        if (hasSelectedOptions) {
          return `Question ${answer.questionId}: Selected option(s) ${answer.selectedOptionIds.join(", ")}`;
        }
        return `Question ${answer.questionId}: No answer provided`;
      });
      return `User questions responses:\n${answerDescriptions?.join("\n") ?? ""}`;
    }
    case "async":
      return "Questions have been sent to the user asynchronously. You will receive their answers later as a separate tool result. Continue with your reasoning using current information.";
    case "rejected":
      return result.result.value.reason?.trim() ||
        "Questions skipped by the user, continue with the information you already have";
    case "error": {
      const errorMessage = result.result.value.errorMessage;
      if (errorMessage === FIRST_ASK_QUESTION_CLIENT_ERROR_MESSAGE) {
        return `Error: ${FIRST_ASK_QUESTION_MODEL_ERROR_MESSAGE}`;
      }
      return `Error: ${errorMessage}`;
    }
    case undefined:
      return "Unknown error";
    default: {
      const exhaustiveCheck: never = result.result;
      throw new Error(`Unhandled result case: ${String(exhaustiveCheck)}`);
    }
  }
}
