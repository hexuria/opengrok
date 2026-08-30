import type { PrivacyMode } from "./privacy-mode.js";
import { PrivacyMode as PrivacyModes } from "./privacy-mode.js";

export enum DataClassification {
  SAFE = "safe",
  CODE = "code",
  CREDENTIALS = "credentials",
  PATH = "path",
  PROVIDER_INFO = "provider_info",
  UNSPECIFIED = "unspecified",
}

export const SENSITIVE_CLASSIFICATIONS = [
  DataClassification.CODE,
  DataClassification.CREDENTIALS,
  DataClassification.PATH,
  DataClassification.PROVIDER_INFO,
  DataClassification.UNSPECIFIED,
];

export enum PrivacyCapability {
  STORAGE_FOR_TRAINING = "storage_for_training",
  STORAGE_FOR_LOGGING = "storage_for_logging",
  STORAGE_FOR_USAGE = "storage_for_usage",
  UNSAFE_ALWAYS_ALLOWED = "unsafe_always_allowed",
}

export function allowedPurpose(
  privacyMode: PrivacyMode,
  purpose: PrivacyCapability,
  classification: DataClassification,
): boolean {
  if (classification === DataClassification.SAFE) return true;
  if (purpose === PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) return true;
  if (
    classification === DataClassification.CREDENTIALS ||
    classification === DataClassification.UNSPECIFIED
  ) return false;
  if (
    purpose !== PrivacyCapability.STORAGE_FOR_TRAINING &&
    purpose !== PrivacyCapability.STORAGE_FOR_LOGGING &&
    purpose !== PrivacyCapability.STORAGE_FOR_USAGE
  ) throw new Error(`Unknown purpose: ${purpose}`);
  switch (privacyMode) {
    case PrivacyModes.NO_STORAGE:
    case PrivacyModes.UNSPECIFIED:
      return false;
    case PrivacyModes.NO_TRAINING:
      if (purpose === PrivacyCapability.STORAGE_FOR_LOGGING) {
        return classification === DataClassification.PATH ||
          classification === DataClassification.PROVIDER_INFO;
      }
      if (purpose === PrivacyCapability.STORAGE_FOR_TRAINING) return false;
      if (purpose === PrivacyCapability.STORAGE_FOR_USAGE) return true;
      throw new Error(`Unknown purpose: ${purpose}`);
    case PrivacyModes.USAGE_DATA_TRAINING_ALLOWED:
    case PrivacyModes.USAGE_CODEBASE_TRAINING_ALLOWED:
      return true;
    default:
      throw new Error(`Unknown privacy mode: ${privacyMode}`);
  }
}
