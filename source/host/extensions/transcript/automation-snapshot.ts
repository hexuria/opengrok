import { triggerIdentity } from "../../automations/automation-trigger.js";
import type { AutomationRecord } from "../../automations/automation.js";
export interface AutomationSnapshot {
  id: string;
  name: string;
  prompt: string;
  trigger: string;
  triggerType: string;
  schedule: string;
  isEnabled: boolean;
  createdAt: number;
  recordedRunCount: number;
}
export function snapshotAutomations(
  automations: readonly AutomationRecord[],
): Map<string, AutomationSnapshot> {
  const map = new Map<string, AutomationSnapshot>();
  for (const automation of automations)
    map.set(automation.id, {
      id: automation.id,
      name: automation.name,
      prompt: automation.prompt,
      trigger: triggerIdentity(automation.trigger),
      triggerType: automation.trigger.type,
      schedule: automation.schedule,
      isEnabled: automation.isEnabled,
      createdAt: automation.createdAt,
      recordedRunCount: automation.runs.length,
    });
  return map;
}
export function diffAutomationAction(
  before: AutomationSnapshot,
  after: AutomationSnapshot,
): "updated" | "enabled" | "disabled" | null {
  if (
    before.name !== after.name ||
    before.prompt !== after.prompt ||
    before.trigger !== after.trigger
  )
    return "updated";
  if (before.isEnabled !== after.isEnabled)
    return after.isEnabled ? "enabled" : "disabled";
  return null;
}
