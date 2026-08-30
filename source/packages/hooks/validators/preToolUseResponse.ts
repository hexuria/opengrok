import { createValidationResult, isObject, validateOptionalString, type ValidationResult } from "./base.js";
import { validateBaseHookResponse } from "./baseHookResponse.js";
export function validatePreToolUseResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value); if (!base.isValid || !isObject(value)) return base; const errors: string[] = [];
  if (value.permission !== undefined) {
    const validPermissions = ["allow", "deny", "ask"];
    if (!validPermissions.includes(value.permission as string)) errors.push(`Invalid permission value. Expected one of: ${validPermissions.join(", ")}, or undefined`);
  }
  if (value.user_message !== undefined && typeof value.user_message !== "string") errors.push("Invalid user_message value. Expected a string if provided");
  if (value.agent_message !== undefined && typeof value.agent_message !== "string") errors.push("Invalid agent_message value. Expected a string if provided");
  if (value.updated_input !== undefined && !isObject(value.updated_input)) errors.push("Invalid updated_input value. Expected a plain object if provided");
  validateOptionalString(value.additional_context, "additional_context", errors); return createValidationResult(errors.length === 0, errors);
}
