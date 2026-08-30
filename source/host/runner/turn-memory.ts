import {
  applyExtractedMemories,
  extractMemories,
  gatherExtractionMemories,
  getEpisodeInterval,
  MEMORY_EPISODE_PREFIX,
  MEMORY_EXTRACTION_ARCHIVE_SCAN_LIMIT,
  MEMORY_RECENT_PROMPT_LIMIT,
  summarizeEpisode,
  type EpisodeTurn,
  type MemoryRecall,
  type MemoryRecord,
  type MemoryStore,
  type TextExecutor,
} from "./sand-memory.js";

export interface TurnMemoryStore extends MemoryStore {
  recall(limit: number): MemoryRecall;
  listMemories(limit: number): readonly MemoryRecord[];
  recordMemoryEvidence?(evidence: {
    readonly occurredAt: number;
    readonly user: string;
    readonly assistant: string;
  }): void;
}

export interface EpisodeProgress {
  clearPendingEpisodeTurns(): void;
  recordEpisodeTurn(turn: EpisodeTurn): void;
  getPendingEpisodeTurns(): readonly EpisodeTurn[];
}

export interface MemorySession {
  getExecutor(): TextExecutor;
}

export interface TurnExchange {
  readonly user: string;
  readonly agent: string;
}

export async function runTurnMemory(
  memoryStore: TurnMemoryStore,
  episodeProgress: EpisodeProgress | null | undefined,
  session: MemorySession,
  context: unknown,
  turnTimestamp: number,
  exchange: TurnExchange,
): Promise<void> {
  if (memoryStore.recordMemoryEvidence != null) {
    episodeProgress?.clearPendingEpisodeTurns();
    memoryStore.recordMemoryEvidence({
      occurredAt: turnTimestamp,
      user: exchange.user,
      assistant: exchange.agent,
    });
    return;
  }
  await runMemoryExtraction(memoryStore, session, context, exchange);
  if (episodeProgress == null) return;
  try {
    episodeProgress.recordEpisodeTurn({
      ts: turnTimestamp,
      user: exchange.user,
      agent: exchange.agent,
    });
    const pending = episodeProgress.getPendingEpisodeTurns();
    if (pending.length < getEpisodeInterval()) return;
    try {
      const narrative = await summarizeEpisode({
        executor: session.getExecutor(),
        ctx: context,
        turns: pending,
      });
      if (narrative != null) {
        const latestTimestamp = pending[pending.length - 1]?.ts ?? turnTimestamp;
        memoryStore.addMemory(
          `${MEMORY_EPISODE_PREFIX}${narrative}`,
          latestTimestamp,
          "log",
        );
      }
    } finally {
      episodeProgress.clearPendingEpisodeTurns();
    }
  } catch {
    // Memory maintenance must never fail the user-visible turn.
  }
}

export async function runMemoryExtraction(
  memoryStore: TurnMemoryStore,
  session: MemorySession,
  context: unknown,
  exchange: TurnExchange,
): Promise<void> {
  try {
    const existingMemories = gatherExtractionMemories(
      memoryStore.recall(MEMORY_RECENT_PROMPT_LIMIT),
      memoryStore.listMemories(MEMORY_EXTRACTION_ARCHIVE_SCAN_LIMIT),
      `${exchange.user}\n${exchange.agent}`,
    );
    const extraction = await extractMemories({
      executor: session.getExecutor(),
      ctx: context,
      userMessage: exchange.user,
      agentMessage: exchange.agent,
      existingMemories,
    });
    applyExtractedMemories(memoryStore, extraction, Date.now(), existingMemories);
  } catch {
    // Extraction is opportunistic and does not participate in turn settlement.
  }
}
