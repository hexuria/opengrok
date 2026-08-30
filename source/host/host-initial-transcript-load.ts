import {
  isSqliteBusyError,
  retrySqliteBusy
} from "./storage/sqlite-busy.js";
import { refreshTranscriptList } from "./transcript-server/transcript-server-bridge.js";

export interface InitialTranscriptLoader<Entry = unknown> {
  ensureLoaded(): Promise<readonly Entry[]>;
  getActiveAgentId?(): string | null;
}

export interface InitialTranscriptLoadOptions {
  readonly isAgentLimitError?: (error: unknown) => boolean;
  readonly logError?: (message: string, error?: unknown) => void;
}

/**
 * Loads the initial transcript while preserving the shipped host's degraded
 * startup behavior. A locked database and an exhausted agent limit keep the
 * gateway alive so the desktop can still show the roster and delete agents.
 * Every other error remains a fatal startup failure.
 */
export async function loadInitialTranscriptResiliently<Entry>(
  transcript: InitialTranscriptLoader<Entry>,
  options: InitialTranscriptLoadOptions = {}
): Promise<number> {
  const isAgentLimitError = options.isAgentLimitError ?? (() => false);
  const logError = options.logError ?? ((message, error) => {
    if (error === undefined) console.error(message);
    else console.error(message, error);
  });

  try {
    const entries = await retrySqliteBusy(() => transcript.ensureLoaded());
    const agentId = transcript.getActiveAgentId?.();
    if (typeof agentId === "string" && agentId.length > 0) {
      await refreshTranscriptList(agentId);
    }
    return entries.length;
  } catch (error) {
    if (isSqliteBusyError(error)) {
      logError(
        "[sand-host] initial transcript load still locked after retries (kept alive):",
        error
      );
      return 0;
    }

    if (isAgentLimitError(error)) {
      logError(
        "[sand-host] no session at the agent cap; starting without one so the roster and delete stay reachable"
      );
      return 0;
    }

    throw error;
  }
}
