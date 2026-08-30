import { SAND_ONBOARDING_STEP_NAMES } from "../../shared/observability/telemetry.js";
const onboardingSteps = new Set<string>(SAND_ONBOARDING_STEP_NAMES);
const directions = new Set(["forward", "back"]);
export const MAX_ONBOARDING_STEP_INDEX = 16;
export interface OnboardingStepReport { readonly step: string; readonly stepIndex: number; readonly direction: string }
export function isValidOnboardingStepReport(value: unknown): value is OnboardingStepReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<OnboardingStepReport>;
  return typeof report.step === "string" && onboardingSteps.has(report.step) && typeof report.stepIndex === "number" && Number.isInteger(report.stepIndex) && report.stepIndex >= 0 && report.stepIndex <= MAX_ONBOARDING_STEP_INDEX && typeof report.direction === "string" && directions.has(report.direction);
}
export function onboardingStepReportToAnalytics(report: OnboardingStepReport) { return { step: report.step, step_index: report.stepIndex, direction: report.direction }; }
