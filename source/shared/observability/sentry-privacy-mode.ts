export enum PrivacyMode { UNSPECIFIED = 0, NO_STORAGE = 1, NO_TRAINING = 2, USAGE_DATA_TRAINING_ALLOWED = 3, USAGE_CODEBASE_TRAINING_ALLOWED = 4 }
export type SandSentryPrivacyTier = "full" | "scrubbed" | "fatal-metadata";
export function sandSentryPrivacyTierForMode(mode?: PrivacyMode): SandSentryPrivacyTier { switch (mode) { case PrivacyMode.USAGE_DATA_TRAINING_ALLOWED: case PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED: return "full"; case PrivacyMode.NO_TRAINING: return "scrubbed"; default: return "fatal-metadata"; } }
