import { createValidationResult, isObject, isString, type ValidationResult } from "./base.js";
import { validateBaseHookResponse } from "./baseHookResponse.js";
export function validateBeforePromptSubmitResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value); if (!base.isValid || !isObject(value)) return base; const errors: string[] = [];
  if (value.continue !== undefined && typeof value.continue !== "boolean") errors.push("continue must be a boolean if provided");
  if (value.user_message !== undefined && !isString(value.user_message)) errors.push("user_message must be a string if provided");
  if (value.additional_context !== undefined && !isString(value.additional_context)) errors.push("additional_context must be a string if provided");
  return createValidationResult(errors.length === 0, errors);
}
