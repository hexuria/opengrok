import { HookAdditionalContext } from "../proto/generated/agent/v1/hook_additional_context_pb.js";
import { HookAdditionalContextTooLargeError } from "./errors.js";
import { HOOK_ADDITIONAL_CONTEXT_MAX_CHARS } from "./limits.js";

function normalizeHookAdditionalContext(content: string | null | undefined): string | undefined {
  const normalized = content?.trim();
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

export function createHookAdditionalContexts({
  hookEventName,
  additionalContext,
}: {
  hookEventName: string;
  additionalContext: string | null | undefined;
}): HookAdditionalContext[] {
  const normalized = normalizeHookAdditionalContext(additionalContext);
  if (normalized === undefined) {
    return [];
  }
  if (normalized.length > HOOK_ADDITIONAL_CONTEXT_MAX_CHARS) {
    throw new HookAdditionalContextTooLargeError({
      hookEventName,
      actualLength: normalized.length,
      maxLength: HOOK_ADDITIONAL_CONTEXT_MAX_CHARS,
    });
  }
  return [
    new HookAdditionalContext({
      hookEventName,
      content: normalized,
    }),
  ];
}
