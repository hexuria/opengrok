import { createValidationResult, isObject, type ValidationResult } from "./base.js";
import { validateBaseHookResponse } from "./baseHookResponse.js";
export function validateStopResponse(value: unknown): ValidationResult { const base = validateBaseHookResponse(value); if (!base.isValid || !isObject(value)) return base; const errors: string[] = []; if (value.followup_message !== undefined && typeof value.followup_message !== "string") errors.push("followup_message must be a string if provided"); return createValidationResult(errors.length === 0, errors); }
