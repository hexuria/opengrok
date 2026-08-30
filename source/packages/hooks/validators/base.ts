export interface ValidationResult { isValid: boolean; errors: string[] }
export const isString = (value: unknown): value is string => typeof value === "string";
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const createValidationResult = (isValid: boolean, errors: string[] = []): ValidationResult => ({ isValid, errors });
export function validateOptionalString(value: unknown, fieldName: string, errors: string[]): void { if (value !== undefined && !isString(value)) errors.push(`${fieldName} must be a string if provided`); }
