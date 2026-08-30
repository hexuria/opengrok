import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";

import { upsertAgentSummary } from "../../../shared/agents/agent-summaries.js";
import { ROSTER_REPLICA_KEY } from "../../../shared/ordering.js";
import { HostReplicaWriter } from "./replica-writer.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

export interface SnapshotStamp {
  snapshotEpoch: string;
  snapshotSeq: number;
}

export type EmitAgentUpdateOutcome = "delta" | "full" | "failed";

export class RosterEmit {
  cachedAgentSummaries: any[] = [];
  readonly snapshotEpoch = randomUUID();
  readonly replicaWriter = new HostReplicaWriter(this.snapshotEpoch);
  rosterCacheSeeded = false;

  private snapshotSeq = 0;
  private emitChain: Promise<void> = Promise.resolve();
  private pendingFullEmit = false;
  private readonly pendingDeltaAgentIds = new Set<string>();
  private pendingEmitFlush: Promise<void> | null = null;

  constructor(
    readonly tm: TranscriptManagerLike,
    readonly emitter: EventEmitter,
  ) {}

  enqueueEmit<T>(work: () => Promise<T>): Promise<T> {
    const run = this.emitChain.then(work, work);
    this.emitChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  emitAgents(): Promise<void> {
    this.pendingFullEmit = true;
    return this.scheduleCoalescedEmit();
  }

  emitAgentUpdate(agentId: string): Promise<void> {
    this.pendingDeltaAgentIds.add(agentId);
    return this.scheduleCoalescedEmit();
  }

  scheduleCoalescedEmit(): Promise<void> {
    if (this.pendingEmitFlush != null) return this.pendingEmitFlush;
    const flush = (async () => {
      await this.tm.taskBoundary.settled();
      await this.enqueueEmit(async () => {
        this.pendingEmitFlush = null;
        const full = this.pendingFullEmit;
        const agentIds = [...this.pendingDeltaAgentIds];
        this.pendingFullEmit = false;
        this.pendingDeltaAgentIds.clear();
        try {
          if (full) {
            await this.runEmitAgents();
            return;
          }
          for (const agentId of agentIds) {
            if ((await this.runEmitAgentUpdate(agentId)) === "full") return;
          }
        } catch (error) {
          console.error(
            "[transcript-manager] coalesced roster emit failed:",
            error,
          );
        }
      });
    })();
    this.pendingEmitFlush = flush;
    return flush;
  }

  reserveSnapshotStamp(): SnapshotStamp {
    return {
      snapshotEpoch: this.snapshotEpoch,
      snapshotSeq: ++this.snapshotSeq,
    };
  }

  applySnapshotStamp<T extends object>(
    agents: readonly T[],
    stamp: SnapshotStamp,
  ): Array<T & SnapshotStamp> {
    return agents.map((agent) => ({ ...agent, ...stamp }));
  }

  finalizeSummaryForRpc<T extends object>(
    summary: T,
    stamp: SnapshotStamp,
  ): T & SnapshotStamp {
    const finalized =
      this.tm.runLifecycle.withRunStates([summary])[0] ?? summary;
    return { ...finalized, ...stamp };
  }

  async runEmitAgents(): Promise<void> {
    if (this.tm.disposed) return;
    const session = await this.tm.sessions.tryEnsureSession();
    const announcedId =
      this.tm.sessions.getAnnouncedActiveAgentId() ?? session?.id;
    const stamp = this.reserveSnapshotStamp();
    const agents = this.applySnapshotStamp(
      this.tm.runLifecycle.withRunStates(
        await this.tm.sessionStore.listAgents(announcedId),
      ),
      stamp,
    );
    this.cachedAgentSummaries = agents;
    this.rosterCacheSeeded = true;
    this.emitter.emit("agents", {
      activeAgentId: announcedId ?? "",
      agents,
      ordered: this.replicaWriter.nextStamp(ROSTER_REPLICA_KEY),
      coverage: { kind: "complete-roster" },
    });
  }

  async buildAgentSummary(agentId: string): Promise<any | null> {
    const activeId = this.tm.sessions.activeSession?.id;
    const announcedId =
      this.tm.sessions.getAnnouncedActiveAgentId() ?? undefined;
    const live =
      activeId === agentId
        ? this.tm.sessions.activeSession
        : (this.tm.sessions.liveSessions.get(agentId) ?? null);
    let summary: any | null = null;
    if (live != null) {
      try {
        summary = await this.tm.sessionStore.summarizeSession(
          live,
          announcedId,
        );
      } catch {
        summary = null;
      }
    }
    if (summary == null) {
      summary = await this.tm.sessionStore.summarizeAgentById(
        agentId,
        announcedId,
      );
    }
    if (summary == null) return null;
    return this.tm.runLifecycle.withRunStates([summary])[0] ?? summary;
  }

  async runEmitAgentUpdate(agentId: string): Promise<EmitAgentUpdateOutcome> {
    if (this.tm.disposed) return "failed";
    try {
      if (!this.rosterCacheSeeded) {
        await this.runEmitAgents();
        return "full";
      }
      const session = await this.tm.sessions.tryEnsureSession();
      if (session == null) {
        await this.runEmitAgents();
        return "full";
      }
      const stamp = this.reserveSnapshotStamp();
      const summary = await this.buildAgentSummary(agentId);
      if (summary == null) {
        await this.runEmitAgents();
        return "full";
      }
      const patched = upsertAgentSummary(this.cachedAgentSummaries, summary);
      const reconciled = this.tm.runLifecycle.withRunStates(patched);
      const siblingChanged = reconciled.some(
        (agent: any, index: number) =>
          agent.id !== agentId && agent !== patched[index],
      );
      if (siblingChanged) {
        await this.runEmitAgents();
        return "full";
      }
      const emitted =
        this.applySnapshotStamp(
          [reconciled.find((agent: any) => agent.id === agentId) ?? summary],
          stamp,
        )[0] ?? summary;
      this.cachedAgentSummaries = upsertAgentSummary(reconciled, emitted);
      this.emitter.emit("agent-upserted", {
        activeAgentId:
          this.tm.sessions.getAnnouncedActiveAgentId() ?? session.id,
        agent: emitted,
        ordered: this.replicaWriter.nextStamp(ROSTER_REPLICA_KEY),
      });
      return "delta";
    } catch (error) {
      console.error(
        `[transcript-manager] incremental emit failed for ${agentId}; falling back to full emit:`,
        error,
      );
      try {
        await this.runEmitAgents();
        return "full";
      } catch {
        return "failed";
      }
    }
  }
}
