import { DataClassification, SENSITIVE_CLASSIFICATIONS } from "./classification.js";
import { resolveEnforceRedaction } from "./privacy-context.js";
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "./privacy-mode.js";

export function shouldRedact(
  privacyMode: PrivacyModeValue,
  classification: DataClassification,
): boolean {
  if (
    classification === DataClassification.CREDENTIALS ||
    classification === DataClassification.UNSPECIFIED
  ) return true;
  if (classification === DataClassification.SAFE) return false;
  if (!SENSITIVE_CLASSIFICATIONS.includes(classification)) return false;
  switch (privacyMode) {
    case PrivacyMode.USAGE_DATA_TRAINING_ALLOWED:
    case PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED:
      return false;
    case PrivacyMode.NO_STORAGE:
    case PrivacyMode.NO_TRAINING:
    case PrivacyMode.UNSPECIFIED:
      return true;
    default:
      return true;
  }
}

export function formatRedacted(fieldName: string): string {
  return `[redacted:${fieldName}]`;
}

export function getRedactionAwareDisplayValue(options: {
  readonly privacyMode: PrivacyModeValue;
  readonly classification: DataClassification;
  readonly fieldName: string;
  readonly unredactedValue: string;
  readonly enforceRedaction?: boolean | undefined;
}): string {
  const { privacyMode, classification, fieldName, unredactedValue } = options;
  const enforceRedaction = resolveEnforceRedaction(
    { privacyMode, enforceRedaction: options.enforceRedaction },
    classification,
  );
  if (!enforceRedaction) return unredactedValue;
  return shouldRedact(privacyMode, classification) ? formatRedacted(fieldName) : unredactedValue;
}
