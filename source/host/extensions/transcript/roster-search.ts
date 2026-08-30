import { getTranscript } from "./transcript-store.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

export interface TranscriptSearchResult {
  agentId: string;
  entryId: string;
  role: string;
  timestampMs: number;
  snippet: string;
}

export class RosterSearch {
  constructor(readonly tm: TranscriptManagerLike) {}

  async searchAgents(
    query: string,
    limit = this.tm.contentSearch.maxResults,
  ): Promise<TranscriptSearchResult[]> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return [];
    if (this.tm.contentSearch.isSearchReady) {
      const indexed = await this.tm.contentSearch.searchMessages({
        query: normalized,
        limit: limit + this.tm.contentSearch.maxMatchesPerAgent,
      });
      if (indexed != null) {
        const liveAgentId = this.tm.sessions.inMemoryTranscriptAgentId;
        const results: TranscriptSearchResult[] = indexed.filter(
          (match: TranscriptSearchResult) =>
            match.agentId !== liveAgentId &&
            this.tm.sessionStore.agentExists(match.agentId),
        );
        if (liveAgentId != null) {
          const entries = getTranscript();
          const newestLiveMs =
            entries.reduce(
              (newest, entry) => Math.max(newest, entry.timestampMs ?? 0),
              0,
            ) || Date.now();
          for (const match of this.tm.contentSearch.findTranscriptMatches(
            entries,
            normalized,
          )) {
            results.push({
              agentId: liveAgentId,
              entryId: match.entryId,
              role: match.role,
              timestampMs:
                match.timestampMs > 0 ? match.timestampMs : newestLiveMs,
              snippet: match.snippet,
            });
          }
        }
        return results
          .sort((left, right) => right.timestampMs - left.timestampMs)
          .slice(0, limit);
      }
    }
    return this.searchAgentsByLinearScan(normalized, limit);
  }

  async searchAgentsByLinearScan(
    normalized: string,
    limit: number,
  ): Promise<TranscriptSearchResult[]> {
    const activeId = this.tm.getActiveAgentId();
    const agents = await this.tm.sessionStore.listAgents(activeId ?? undefined);
    const results: TranscriptSearchResult[] = [];
    for (const agent of agents) {
      const entries =
        activeId != null && agent.id === activeId
          ? getTranscript()
          : this.tm.sessionStore.readAgentTranscriptEntries(agent.id);
      for (const match of this.tm.contentSearch.findTranscriptMatches(
        entries,
        normalized,
      )) {
        results.push({
          agentId: agent.id,
          entryId: match.entryId,
          role: match.role,
          timestampMs:
            match.timestampMs > 0 ? match.timestampMs : agent.updatedAt,
          snippet: match.snippet,
        });
      }
    }
    return results
      .sort((left, right) => right.timestampMs - left.timestampMs)
      .slice(0, limit);
  }

  async searchMedia(
    query: string,
    limit = this.tm.contentSearch.maxResults,
  ): Promise<any[]> {
    if (!this.tm.contentSearch.isSearchReady) return [];
    const matches = await this.tm.contentSearch.searchMedia({
      query: query.trim(),
      limit,
    });
    if (matches == null) return [];
    return matches.filter((match: any) =>
      this.tm.sessionStore.agentExists(match.agentId),
    );
  }
}
