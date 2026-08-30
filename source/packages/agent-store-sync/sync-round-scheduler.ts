type SyncRoundKind = "full" | "path";

type SyncRoundRun<T> = (signal: AbortSignal | undefined) => Promise<T>;

interface PendingRound<T> {
  readonly kind: SyncRoundKind;
  readonly run: SyncRoundRun<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

const ROUND_ABANDONED = Symbol("sync-round-abandoned");

export class SyncRoundStoodAsideError extends Error {
  constructor() {
    super("Agent store full sync stood aside for path sync");
    this.name = "SyncRoundStoodAsideError";
  }
}

export function isSyncRoundStoodAsideError(error: unknown): error is SyncRoundStoodAsideError {
  return error instanceof SyncRoundStoodAsideError;
}

export class SyncRoundScheduler<T = unknown> {
  private pending: Array<PendingRound<T>> = [];
  private pumping: Promise<void> | undefined;
  private fullRoundStandAside: AbortController | undefined;
  private abandonInFlightReject: ((reason?: unknown) => void) | undefined;

  enqueue(kind: SyncRoundKind, run: SyncRoundRun<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRound<T> = { kind, run, resolve, reject };
      if (kind === "path") {
        this.fullRoundStandAside?.abort(new SyncRoundStoodAsideError());
        const fullIdx = this.pending.findIndex(item => item.kind === "full");
        if (fullIdx === -1) {
          this.pending.push(entry);
        } else {
          this.pending.splice(fullIdx, 0, entry);
        }
      } else {
        this.pending.push(entry);
      }
      void this.ensurePump();
    });
  }

  /**
   * Unjam the pump after a session watchdog abandons a wedged round. Rejects
   * not-yet-started pending entries, stops awaiting the in-flight body (which
   * continues in the background and still settles its enqueue promise), and
   * lets a later `enqueue` start a fresh pump once fail-fast clears.
   */
  abandonInFlight(): void {
    const pending = this.pending.splice(0);
    for (const entry of pending) {
      entry.reject(new Error("Agent store sync round abandoned by watchdog"));
    }
    this.abandonInFlightReject?.(ROUND_ABANDONED);
    this.abandonInFlightReject = undefined;
    this.fullRoundStandAside = undefined;
  }

  async drain(): Promise<void> {
    while (this.pending.length > 0 || this.pumping !== undefined) {
      await (this.pumping ?? Promise.resolve());
    }
  }

  private ensurePump(): void {
    if (this.pumping !== undefined) {
      return;
    }
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      if (this.pending.length > 0) {
        this.ensurePump();
      }
    });
  }

  private async pump(): Promise<void> {
    while (this.pending.length > 0) {
      const next = this.pending.shift()!;
      const standAside = next.kind === "full" ? new AbortController() : undefined;
      if (standAside !== undefined) {
        this.fullRoundStandAside = standAside;
      }
      const runPromise = next.run(standAside?.signal);
      const abandonPromise = new Promise<never>((_resolve, reject) => {
        this.abandonInFlightReject = reject;
      });
      try {
        const summary = await Promise.race([runPromise, abandonPromise]);
        next.resolve(summary);
      } catch (error) {
        if (error === ROUND_ABANDONED) {
          void runPromise.then(next.resolve, next.reject);
          break;
        }
        next.reject(error);
      } finally {
        if (this.abandonInFlightReject !== undefined) {
          this.abandonInFlightReject = undefined;
        }
        if (this.fullRoundStandAside === standAside) {
          this.fullRoundStandAside = undefined;
        }
      }
    }
  }
}
