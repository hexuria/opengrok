export type TeamRulesLoadResult<T> =
  | { readonly outcome: "rules"; readonly rules: readonly T[] }
  | { readonly outcome: "no_team" }
  | { readonly outcome: "incomplete" };

export interface SandTeamRulesResolver<T> {
  start(): void;
  refresh(): void;
  resolveRules(): Promise<readonly T[] | undefined>;
}

export function createSandTeamRulesResolverFromLoad<T>(options: {
  readonly load: () => Promise<TeamRulesLoadResult<T>>;
  readonly reportLoadFailure: (error: unknown) => void;
}): SandTeamRulesResolver<T> {
  let snapshot: readonly T[] | undefined;
  let inFlight: Promise<void> | undefined;

  const runLoad = async (): Promise<void> => {
    let result: TeamRulesLoadResult<T>;
    try {
      result = await options.load();
    } catch (error) {
      options.reportLoadFailure(error);
      return;
    }
    if (result.outcome === "rules") {
      snapshot = result.rules;
      return;
    }
    if (result.outcome === "no_team") snapshot = [];
  };

  const ensureLoad = (): Promise<void> => {
    if (inFlight === undefined) {
      inFlight = runLoad().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };

  return {
    start() {
      void ensureLoad();
    },
    refresh() {
      void (async () => {
        const prior = inFlight;
        if (prior !== undefined) await prior;
        await ensureLoad();
      })();
    },
    async resolveRules() {
      if (snapshot !== undefined) return snapshot;
      await ensureLoad();
      return snapshot;
    },
  };
}
