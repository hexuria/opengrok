import { HookStep } from "../hook-step.js";
import { createValidationResult, isObject, isString, type ValidationResult } from "./base.js";

function validateCommonHookProperties(value: Record<string, unknown>, errors: string[]): void {
  if (value.matcher !== undefined) { if (!isString(value.matcher)) errors.push("Hook script matcher must be a string if provided"); else if (value.matcher !== "" && value.matcher !== "*") try { new RegExp(value.matcher); } catch (error) { errors.push(`Hook script matcher "${value.matcher}" is not a valid regex: ${(error as { message?: unknown } | null)?.message ?? String(error)}`); } }
  if (value.timeout !== undefined) { if (typeof value.timeout !== "number") errors.push("Hook script timeout must be a number (seconds)"); else if (value.timeout <= 0) errors.push("Hook script timeout must be a positive number"); else if (value.timeout > 3600) console.warn(`[hooks] Hook timeout of ${value.timeout}s is very long (>1 hour)`); }
  if (value.loop_limit !== undefined) { const limit = value.loop_limit; if (limit !== null) { if (typeof limit !== "number") errors.push("Hook script loop_limit must be a positive integer or null"); else if (!Number.isInteger(limit)) errors.push("Hook script loop_limit must be an integer"); else if (limit <= 0) errors.push("Hook script loop_limit must be a positive integer (use null for no limit)"); } }
  if (value.failClosed !== undefined && typeof value.failClosed !== "boolean") errors.push("Hook script failClosed must be a boolean");
}
function validateHookScript(value: unknown): ValidationResult {
  const errors: string[] = []; if (!isObject(value)) return createValidationResult(false, ["Hook script must be an object with either a 'command' property (command hook) or 'type: \"prompt\"' with a 'prompt' property (prompt hook)"]);
  if (value.type === "prompt") { if (!isString(value.prompt)) errors.push("Prompt hook must have a 'prompt' property (string)"); else if (value.prompt.trim() === "") errors.push("Prompt hook 'prompt' property cannot be empty"); if (value.model !== undefined) { if (!isString(value.model)) errors.push("Prompt hook 'model' must be a string if provided"); else if (value.model.trim() === "") errors.push("Prompt hook 'model' cannot be an empty string"); } }
  else if (value.type === "command" || value.type === undefined) { if (!isString(value.command)) errors.push("Hook script command must be a string"); }
  else errors.push(`Invalid hook type: "${value.type}". Must be "command", "prompt", or omitted (defaults to "command")`);
  validateCommonHookProperties(value, errors); return createValidationResult(errors.length === 0, errors);
}
function validateHookScriptArray(value: unknown, hookName: string): ValidationResult { if (!Array.isArray(value)) return createValidationResult(false, [`${hookName} must be an array of hook scripts`]); const errors: string[] = []; for (let index = 0; index < value.length; index++) { const validation = validateHookScript(value[index]); if (!validation.isValid) errors.push(`${hookName}[${index}]: ${validation.errors.join(", ")}`); } return createValidationResult(errors.length === 0, errors); }
export function validateHooksConfig(value: unknown): ValidationResult {
  const errors: string[] = []; if (!isObject(value)) return createValidationResult(false, ["Hooks config must be an object"]);
  if (typeof value.version !== "number") errors.push("Config version must be a number"); else if (!Number.isInteger(value.version) || value.version < 1) errors.push("Config version must be a positive integer");
  if (!isObject(value.hooks)) { errors.push("Config hooks must be an object"); return createValidationResult(false, errors); }
  if (value.stop_hook_loop_limit !== undefined) console.warn("[hooks] DEPRECATION WARNING: 'stop_hook_loop_limit' is deprecated. Use 'loop_limit' on individual hook scripts instead. The configured value is being ignored.");
  const validHookTypes = Object.values(HookStep); for (const [hookName, hookValue] of Object.entries(value.hooks)) { if (!(validHookTypes as string[]).includes(hookName)) { errors.push(`Unknown hook type: ${hookName}. Valid types are: ${validHookTypes.join(", ")}`); continue; } if (hookValue !== undefined) { const validation = validateHookScriptArray(hookValue, hookName); if (!validation.isValid) errors.push(...validation.errors); } }
  return createValidationResult(errors.length === 0, errors);
}
