import { join } from "node:path";
import { createDeadlinePolicy, realClock } from "../../../internal/scheduling.js";
import { defineHostExtension } from "../../../internal/host-extensions.js";
import { subscribeTranscriptMutations } from "../../transcript-mutation-events.js";
import { getSandRootDir } from "../../host-paths.js";
import { getSandAgentsRootDir } from "../../storage/agent-paths.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT, AGENT_CONTENT_SEARCH_MAX_RESULTS, findAgentContentMatches } from "./agent-content-search.js";
import { SEARCH_INDEX_FILENAME } from "./search-index-db.js";
import { SandSearchIndexService, SEARCH_INDEX_DISPOSE_TIMEOUT_MS, type TranscriptMutation } from "./search-index-service.js";

export const GLOBAL_SEARCH_GATE = "sand_global_search";

interface FeatureGateProperty { get(): boolean; subscribe(listener: (value: boolean) => void): () => void }

export const contentSearchExtension = defineHostExtension({
  id: HostExtensions.ContentSearch,
  dependencies: [HostExtensions.Experiments, HostExtensions.Telemetry],
  start: (context) => {
    const deps = context.deps as {
      experiments: { checkFeatureGate(name: string): boolean; getFeatureGateProperty(name: string): FeatureGateProperty };
      telemetry: { logs: { reportSearchIndexHealth(value: Record<string, unknown>): void } };
    };
    const index = new SandSearchIndexService({
      indexDbPath: join(getSandRootDir(), SEARCH_INDEX_FILENAME),
      agentsRootDir: getSandAgentsRootDir(),
      disposeDeadline: createDeadlinePolicy(realClock, { name: "sand-content-search-dispose", timeoutMs: SEARCH_INDEX_DISPOSE_TIMEOUT_MS }),
      report: (value) => deps.telemetry.logs.reportSearchIndexHealth(value)
    });
    context.onStop(() => index.dispose());
    let unsubscribeMutations: (() => void) | undefined;
    const subscribe = subscribeTranscriptMutations as unknown as (listener: (mutation: TranscriptMutation) => void) => () => void;
    const applyGate = (isEnabled: boolean) => {
      if (!isEnabled) { unsubscribeMutations?.(); unsubscribeMutations = undefined; return; }
      unsubscribeMutations ??= subscribe((mutation) => index.applyMutation(mutation));
      index.start();
    };
    context.onStop(() => unsubscribeMutations?.());
    const gate = deps.experiments.getFeatureGateProperty(GLOBAL_SEARCH_GATE);
    context.onStop(gate.subscribe(applyGate));
    applyGate(gate.get());
    return {
      isEnabled: () => deps.experiments.checkFeatureGate(GLOBAL_SEARCH_GATE),
      get isSearchReady() { return index.isSearchReady; },
      maxMatchesPerAgent: AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT,
      maxResults: AGENT_CONTENT_SEARCH_MAX_RESULTS,
      searchMessages: ({ query, limit }: { query: string; limit: number }) => index.searchMessages(query, limit),
      searchMedia: ({ query, limit }: { query: string; limit: number }) => index.searchMedia(query, limit),
      findTranscriptMatches: findAgentContentMatches
    };
  }
});
