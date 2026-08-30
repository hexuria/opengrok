import type { HookAdditionalContext } from "../proto/generated/agent/v1/hook_additional_context_pb.js";
import { sanitizeSystemReminderContent } from "../hooks/sanitize-system-reminder.js";

export function renderHookAdditionalContextContents(
  hookAdditionalContexts: readonly HookAdditionalContext[],
): string[] {
  return hookAdditionalContexts
    .map((context) => context.content.trim())
    .filter((content) => content.length > 0);
}

export function renderHookAdditionalContextSystemReminders(
  hookAdditionalContexts: readonly HookAdditionalContext[],
): string[] {
  return renderHookAdditionalContextContents(hookAdditionalContexts).map(
    (content) => `<system_reminder>\n${sanitizeSystemReminderContent(content)}\n</system_reminder>`,
  );
}

export function appendHookContextRemindersToCoreToolResult(
  textParts: string[],
  toolResultContent: Array<{ type: "text"; text: string }>,
  contexts: readonly HookAdditionalContext[],
): void {
  const reminders = renderHookAdditionalContextSystemReminders(contexts);
  for (const text of reminders) {
    textParts.push(text);
    toolResultContent.push({ type: "text", text });
  }
}
