export const PrivacyMode = {
  UNSPECIFIED: 0,
  NO_STORAGE: 1,
  NO_TRAINING: 2,
  USAGE_DATA_TRAINING_ALLOWED: 3,
  USAGE_CODEBASE_TRAINING_ALLOWED: 4,
} as const;

export type PrivacyMode = (typeof PrivacyMode)[keyof typeof PrivacyMode];
