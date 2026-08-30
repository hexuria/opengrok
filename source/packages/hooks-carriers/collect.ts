import type { HookAdditionalContext } from "../proto/generated/agent/v1/hook_additional_context_pb.js";

export function appendHookAdditionalContexts(
  collector: HookAdditionalContext[] | undefined,
  contexts: readonly HookAdditionalContext[],
): void {
  if (collector !== undefined && contexts.length > 0) {
    collector.push(...contexts);
  }
}
