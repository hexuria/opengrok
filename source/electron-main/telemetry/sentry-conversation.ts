import { isSandSentryBoundedTagValue } from "../../shared/observability/sentry-scrub.gen.js";
export function isValidSentryConversationReport(value: unknown): value is { readonly agentId: string | null } {
  if (typeof value !== "object" || value === null) return false;
  const agentId = (value as { agentId?: unknown }).agentId;
  return agentId === null || isSandSentryBoundedTagValue(agentId);
}
