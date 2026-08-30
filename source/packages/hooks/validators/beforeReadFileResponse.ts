import { createValidationResult, isObject, type ValidationResult } from "./base.js";
import { validateBaseHookResponse } from "./baseHookResponse.js";
export function validateBeforeReadFileResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value); if (!base.isValid || !isObject(value)) return base; const errors: string[] = [];
  if (value.permission !== undefined) {
    const validPermissions = ["allow", "deny"];
    if (!validPermissions.includes(value.permission as string)) errors.push(`Invalid permission value. Expected one of: ${validPermissions.join(", ")}, or undefined`);
  }
  if (value.user_message !== undefined && typeof value.user_message !== "string") errors.push("user_message must be a string if provided");
  return createValidationResult(errors.length === 0, errors);
}
