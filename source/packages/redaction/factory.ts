import { DataClassification } from "./classification.js";
import type { PrivacyContext } from "./privacy-context.js";
import { type PrivacyMode as PrivacyModeValue, PrivacyMode } from "./privacy-mode.js";
import { RedactedBytes, RedactedString } from "./types.js";

export function createRedactedString(
  value: string,
  classification: DataClassification,
  fieldName: string,
  modeOrContext: PrivacyModeValue | PrivacyContext,
): RedactedString {
  return new RedactedString(value, classification, fieldName, modeOrContext);
}

export function createRedactedBytes(
  value: Uint8Array,
  classification: DataClassification,
  fieldName: string,
  modeOrContext: PrivacyModeValue | PrivacyContext,
): RedactedBytes {
  return new RedactedBytes(value, classification, fieldName, modeOrContext);
}

export function safeString(value: string): RedactedString {
  return createRedactedString(
    value,
    DataClassification.SAFE,
    "safe",
    PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED,
  );
}

const CLASSIFICATION_STRICTNESS = {
  [DataClassification.CREDENTIALS]: 4,
  [DataClassification.UNSPECIFIED]: 4,
  [DataClassification.CODE]: 3,
  [DataClassification.PATH]: 2,
  [DataClassification.PROVIDER_INFO]: 2,
  [DataClassification.SAFE]: 1,
};

const PRIVACY_MODE_STRICTNESS = {
  [PrivacyMode.UNSPECIFIED]: 5,
  [PrivacyMode.NO_STORAGE]: 4,
  [PrivacyMode.NO_TRAINING]: 3,
  [PrivacyMode.USAGE_DATA_TRAINING_ALLOWED]: 2,
  [PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED]: 1,
};
