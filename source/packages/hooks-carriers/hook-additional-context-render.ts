import { sanitizeSystemReminderContent } from "../hooks/sanitize-system-reminder.js";
import { HOOK_ADDITIONAL_CONTEXT_MAX_CHARS } from "./limits.js";

export function renderHookAdditionalContextSystemReminder(
  content: string | null | undefined,
  onOversize?: ((actualLength: number, maxLength: number) => void) | undefined,
): string | undefined {
  const normalized = content?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > HOOK_ADDITIONAL_CONTEXT_MAX_CHARS) {
    onOversize?.(normalized.length, HOOK_ADDITIONAL_CONTEXT_MAX_CHARS);
    return undefined;
  }
  const sanitized = sanitizeSystemReminderContent(normalized);
  return `<system_reminder>\n${sanitized}\n</system_reminder>`;
}
