import { HookStep, type HookStepValue } from "../hooks/hook-step.js";
import { HOOK_STEPS_SUPPORTING_ADDITIONAL_CONTEXT } from "../hooks/types.js";

type HookStepAdditionalContextEventName =
  | typeof HookStep.sessionStart
  | typeof HookStep.beforeSubmitPrompt
  | typeof HookStep.preToolUse
  | typeof HookStep.postToolUse
  | typeof HookStep.postToolUseFailure;

export const HOOK_STEP_CARRIER_SPECS = Object.fromEntries(
  Array.from(HOOK_STEPS_SUPPORTING_ADDITIONAL_CONTEXT).map((step) => {
    if (!isHookStepAdditionalContextEventName(step)) {
      throw new Error(
        `HOOK_STEPS_SUPPORTING_ADDITIONAL_CONTEXT lists ${step} but HookStepAdditionalContextEventName does not include it. Extend the Extract<> union in spec.ts.`,
      );
    }
    return [step, { hookEventName: step }];
  }),
) as Record<HookStepAdditionalContextEventName, { hookEventName: HookStepAdditionalContextEventName }>;

function isHookStepAdditionalContextEventName(
  step: HookStepValue,
): step is HookStepAdditionalContextEventName {
  return (
    step === HookStep.sessionStart ||
    step === HookStep.beforeSubmitPrompt ||
    step === HookStep.preToolUse ||
    step === HookStep.postToolUse ||
    step === HookStep.postToolUseFailure
  );
}
