import { createValidationResult, isObject, type ValidationResult } from "./base.js";
import { validateBaseHookResponse } from "./baseHookResponse.js";
export function validateBeforeCommandExecutionHookResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value); if (!base.isValid || !isObject(value)) return base; const errors: string[] = [];
  if (value.permission !== undefined) {
    const validPermissions = ["allow", "deny", "ask"];
    if (!validPermissions.includes(value.permission as string)) errors.push(`Invalid permission value. Expected one of: ${validPermissions.join(", ")}, or undefined`);
  }
  if (value.user_message !== undefined && typeof value.user_message !== "string") errors.push("Invalid user_message value. Expected a string if provided");
  if (value.agent_message !== undefined && typeof value.agent_message !== "string") errors.push("Invalid agent_message value. Expected a string if provided");
  return createValidationResult(errors.length === 0, errors);
}
