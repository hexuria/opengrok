export const TEAM_RULES_REQUEST_TIMEOUT_MS = 10_000;
export const TeamRuleAgentType = { UNSPECIFIED: 0, ALL: 1, SAND: 2, CURSOR: 3 } as const;
export interface TeamRule { agentType: number; name: string; content: string; globs?: readonly string[] | null; isRequired: boolean }
export interface CursorTeamRule { fullPath: string; content: string; type: { kind: "global" } | { kind: "fileGlobbed"; globs: string[] }; source: "team"; isRequired: boolean }
export function appliesToSand(rule: Pick<TeamRule, "agentType">): boolean { return rule.agentType === TeamRuleAgentType.SAND || rule.agentType === TeamRuleAgentType.ALL; }
export function directMemberTeamIds(response: { teams: readonly { id: number; isDirectMember: boolean }[] }): number[] { return response.teams.filter((team) => team.id > 0 && team.isDirectMember).map((team) => team.id); }
export function teamRuleToCursorRule(rule: TeamRule): CursorTeamRule { const globs = rule.globs ?? []; return { fullPath: rule.name, content: rule.content, type: globs.length > 0 ? { kind: "fileGlobbed", globs: [...globs] } : { kind: "global" }, source: "team", isRequired: rule.isRequired }; }
export function mergeRulesByFullPath<T extends { fullPath: string }>(batches: readonly (readonly T[])[]): T[] { const seen = new Set<string>(), merged: T[] = []; for (const batch of batches) for (const rule of batch) if (!seen.has(rule.fullPath)) { seen.add(rule.fullPath); merged.push(rule); } return merged; }
export type TeamRulesLoadResult<T> = { outcome: "rules"; rules: readonly T[] } | { outcome: "no_team" } | { outcome: "incomplete" };
export function createSandTeamRulesResolverFromLoad<T>(options: { load(): Promise<TeamRulesLoadResult<T>>; reportLoadFailure(error: unknown): void }): { start(): void; refresh(): void; resolveRules(): Promise<readonly T[] | undefined> } {
  let snapshot: readonly T[] | undefined, inFlight: Promise<void> | undefined;
  const runLoad = async (): Promise<void> => { let result: TeamRulesLoadResult<T>; try { result = await options.load(); } catch (error) { options.reportLoadFailure(error); return; } if (result.outcome === "rules") snapshot = result.rules; else if (result.outcome === "no_team") snapshot = []; };
  const ensureLoad = (): Promise<void> => { if (inFlight === undefined) inFlight = runLoad().finally(() => { inFlight = undefined; }); return inFlight; };
  return { start: () => { void ensureLoad(); }, refresh: () => { void (async () => { const prior = inFlight; if (prior !== undefined) await prior; await ensureLoad(); })(); }, async resolveRules() { if (snapshot !== undefined) return snapshot; await ensureLoad(); return snapshot; } };
}
export interface TeamRulesClient { getTeams(request: { activeOnly: true }, options: { timeoutMs: number }): Promise<{ teams: readonly { id: number; isDirectMember: boolean }[] }>; getTeamRules(request: { activeOnly: true; teamId: number }, options: { timeoutMs: number }): Promise<{ rules: readonly TeamRule[] }> }
export function createSandTeamRulesResolver(options: { client: TeamRulesClient; report?(event: { extension: "managed_setup"; kind: string; errorClass: string }): void }): ReturnType<typeof createSandTeamRulesResolverFromLoad<CursorTeamRule>> {
  const report = options.report ?? (() => {}); const label = (error: unknown): string => error instanceof Error ? error.name || "Error" : typeof error;
  return createSandTeamRulesResolverFromLoad({
    load: async () => { let ids: number[]; try { ids = directMemberTeamIds(await options.client.getTeams({ activeOnly: true }, { timeoutMs: TEAM_RULES_REQUEST_TIMEOUT_MS })); } catch (error) { report({ extension: "managed_setup", kind: "team_rules_membership", errorClass: label(error) }); return { outcome: "incomplete" }; } if (ids.length === 0) return { outcome: "no_team" }; try { const batches = await Promise.all(ids.map(async (teamId) => (await options.client.getTeamRules({ activeOnly: true, teamId }, { timeoutMs: TEAM_RULES_REQUEST_TIMEOUT_MS })).rules.filter(appliesToSand).map(teamRuleToCursorRule))); return { outcome: "rules", rules: mergeRulesByFullPath(batches) }; } catch (error) { report({ extension: "managed_setup", kind: "team_rules_fetch", errorClass: label(error) }); return { outcome: "incomplete" }; } },
    reportLoadFailure: (error) => report({ extension: "managed_setup", kind: "team_rules_retry", errorClass: label(error) })
  });
}
