import { createValidationResult, isObject, validateOptionalString, type ValidationResult } from "./base.js";
import { validateBaseHookResponse } from "./baseHookResponse.js";
export function validatePostToolUseFailureResponse(value: unknown): ValidationResult { const base = validateBaseHookResponse(value); if (!base.isValid || !isObject(value)) return base; const errors: string[] = []; validateOptionalString(value.additional_context, "additional_context", errors); return createValidationResult(errors.length === 0, errors); }
