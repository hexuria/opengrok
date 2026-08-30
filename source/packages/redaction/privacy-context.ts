import type { DataClassification } from "./classification.js";
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "./privacy-mode.js";

export interface PrivacyContext {
  readonly privacyMode: PrivacyModeValue;
  readonly enforceRedaction?: boolean | undefined;
}

let enforceRedactionGate: (() => boolean | undefined) | undefined;

function isGlobalEnforcementEnabled(): boolean {
  return enforceRedactionGate?.() ?? false;
}

export function resolveEnforceRedaction(
  context: PrivacyContext,
  classification: DataClassification,
): boolean {
  if (context.enforceRedaction === false) return false;
  if (context.enforceRedaction === true) return true;
  void classification;
  return context.privacyMode !== PrivacyMode.UNSPECIFIED && isGlobalEnforcementEnabled();
}

export function privacyContextFromMode(
  privacyMode: PrivacyModeValue,
  enforceRedaction?: boolean,
): PrivacyContext {
  return enforceRedaction !== undefined ? { privacyMode, enforceRedaction } : { privacyMode };
}

export function toPrivacyContext(
  modeOrContext: PrivacyModeValue | PrivacyContext,
): PrivacyContext {
  if (
    typeof modeOrContext === "object" &&
    modeOrContext !== null &&
    "privacyMode" in modeOrContext
  ) return modeOrContext;
  return privacyContextFromMode(modeOrContext);
}
