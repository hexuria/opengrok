export interface AgentSummaryIdentity {
  readonly id: string;
  readonly updatedAt: number;
}

export function compareAgentSummaries(
  a: AgentSummaryIdentity,
  b: AgentSummaryIdentity,
): number {
  return b.updatedAt - a.updatedAt;
}

export function upsertAgentSummary<T extends AgentSummaryIdentity>(
  summaries: readonly T[],
  updated: T,
): T[] {
  let found = false;
  const next = summaries.map((summary) => {
    if (summary.id !== updated.id) return summary;
    found = true;
    return updated;
  });
  if (!found) next.push(updated);
  return next.sort(compareAgentSummaries);
}
