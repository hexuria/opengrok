export const TEAM_PLUGIN_POPULARITY_REQUEST_TIMEOUT_MS = 12_000;
export async function fetchTeamPluginPopularity(deps: { readonly client: { getMe(request: unknown, options: { timeoutMs: number }): Promise<{ teamId?: unknown }>; getTeamPluginPopularity(request: { teamId: unknown }, options: { timeoutMs: number }): Promise<{ counts: readonly { pluginId: { toString(): string }; memberInstallCount: number }[] }> }; readonly createGetMeRequest?: () => unknown; readonly createPopularityRequest?: (teamId: unknown) => { teamId: unknown } }): Promise<Map<string, number>> {
  try {
    const me = await deps.client.getMe(deps.createGetMeRequest?.() ?? {}, { timeoutMs: TEAM_PLUGIN_POPULARITY_REQUEST_TIMEOUT_MS });
    if (me.teamId == null) return new Map();
    const response = await deps.client.getTeamPluginPopularity(deps.createPopularityRequest?.(me.teamId) ?? { teamId: me.teamId }, { timeoutMs: TEAM_PLUGIN_POPULARITY_REQUEST_TIMEOUT_MS });
    const counts = new Map<string, number>();
    for (const entry of response.counts) counts.set(entry.pluginId.toString(), entry.memberInstallCount);
    return counts;
  } catch { return new Map(); }
}
