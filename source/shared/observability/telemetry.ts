export const SAND_ACCESS_BLOCKED_CAUSES = ["wrong_account_suspected", "seat_revoked", "plan_expired", "no_plan", "unknown"] as const;
export const SAND_ONBOARDING_STEP_NAMES = ["meet", "computer-demo", "jobs", "tools", "create", "hand-off"] as const;
export const SAND_QUEUED_FLUSH_CAUSE_CODES = { nonceMismatch: "SAND-E0703", capabilityUnavailable: "SAND-E0704", hostRejected: "SAND-E0705", superseded: "SAND-E0706", ackExpired: "SAND-E0707" } as const;
export const SAND_CLIENT_PERSISTENCE_SLICES = ["client-meta.account-slot", "composer-drafts", "host-settings.onboarding", "roster.agent-avatars", "roster.last-roster", "selection.last-agent", "send-journal", "sidebar.last-sections", "transcript.replicas", "ui-agent-refs", "ui-layout", "other"] as const;
const sliceSet = new Set<string>(SAND_CLIENT_PERSISTENCE_SLICES);
export function isSandClientPersistenceSlice(value: unknown): value is (typeof SAND_CLIENT_PERSISTENCE_SLICES)[number] { return typeof value === "string" && sliceSet.has(value); }
