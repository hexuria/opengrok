import { createValidationResult, isObject, type ValidationResult } from "./base.js";
export function validateBaseHookResponse(value: unknown): ValidationResult { return isObject(value) ? createValidationResult(true) : createValidationResult(false, ["Expected an object"]); }
