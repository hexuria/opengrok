import {
  AUTOMATION_UI_LIMIT,
  renderAutomationRuntimeStatusReminder,
  type AutomationRecord,
} from "./automation.js";

export interface AutomationStatusReminderStore {
  getLocation(): string | null | undefined;
  list(): readonly AutomationRecord[];
  listDefinitions?(): readonly AutomationRecord[];
}

export interface AutomationStatusReminderRequestContext {
  resolve(): { readonly timeZone?: string | undefined };
}

export interface AutomationStatusReminderProviderDependencies {
  readonly automationStore?: () => AutomationStatusReminderStore | null | undefined;
  readonly requestContext: AutomationStatusReminderRequestContext;
}

/**
 * Projects the live automation store into the prompt-glue reminder callback.
 * Prompt glue owns the per-turn dedupe/compaction memory; this provider only
 * performs the immutable store, timezone, cap, and firing-id projection.
 */
export function createAutomationStatusReminderProvider(
  dependencies: AutomationStatusReminderProviderDependencies,
): (firingAutomationId?: string) => string | null {
  return (firingAutomationId?: string): string | null => {
    const store = dependencies.automationStore?.();
    if (store == null || store.getLocation() == null) return null;
    const definitions = store.listDefinitions?.() ?? store.list();
    return renderAutomationRuntimeStatusReminder(
      definitions.slice(0, AUTOMATION_UI_LIMIT),
      dependencies.requestContext.resolve().timeZone,
      firingAutomationId == null ? undefined : { firingAutomationId },
    );
  };
}
