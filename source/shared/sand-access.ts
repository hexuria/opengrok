export const SAND_ACCESS_CHECKING = { state: "checking", reason: "unspecified" } as const;
export const SAND_ACCESS_UNKNOWN = { state: "unknown", reason: "unspecified" } as const;
export const SAND_ACCESS_BLOCK_REASONS = new Set(["unspecified", "none", "teamPrivacyMode", "teamSetupRequired", "teamAccessRequired", "notOffered", "freeTrialAvailable", "paywallIndividual", "paywallTeamMember", "paywallTeamAdmin"]);
export function isSandAccessBlockReason(value: unknown): value is string { return typeof value === "string" && SAND_ACCESS_BLOCK_REASONS.has(value); }
