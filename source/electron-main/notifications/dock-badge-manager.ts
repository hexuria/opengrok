import { computeDockBadgeTotal, type DockBadgeAgent } from "./dock-badge.js";

export interface DockBadgeRosterAgent extends DockBadgeAgent {
  readonly id: string;
  readonly hasUnread: boolean;
  readonly snapshotEpoch?: string | null;
  readonly snapshotSeq?: number | null;
}

interface TrackedAgent {
  readonly snapshot: DockBadgeAgent & { readonly id: string };
  readonly epoch: string;
  readonly seq: number;
}

export function isStaleDockBadgeRow(tracked: TrackedAgent, incoming: DockBadgeRosterAgent): boolean {
  return tracked.epoch === (incoming.snapshotEpoch ?? "") && (incoming.snapshotSeq ?? 0) < tracked.seq;
}

export function toDockBadgeSnapshot(agent: DockBadgeRosterAgent): DockBadgeAgent & { readonly id: string } {
  return { id: agent.id, hasUnread: agent.hasUnread, unreadCount: agent.unreadCount ?? null, isHiddenFromSidebar: agent.isHiddenFromSidebar === true };
}

function toTrackedAgent(agent: DockBadgeRosterAgent): TrackedAgent {
  return { snapshot: toDockBadgeSnapshot(agent), epoch: agent.snapshotEpoch ?? "", seq: agent.snapshotSeq ?? 0 };
}

export class SandDockBadgeManager {
  private agents = new Map<string, TrackedAgent>();
  private projectedTotal: number | null = null;

  constructor(private readonly deps: {
    readonly setBadgeCount: (count: number) => void;
    readonly reportFailure?: (operation: "set-count", error: unknown) => void;
  }) {}

  handleAgentsEvent(event: { readonly agents: readonly DockBadgeRosterAgent[] }): void { this.applyRoster(event.agents); }

  handleAgentUpsertedEvent(event: { readonly agent: DockBadgeRosterAgent }): void {
    const tracked = this.agents.get(event.agent.id);
    if (tracked != null && isStaleDockBadgeRow(tracked, event.agent)) return;
    this.agents.set(event.agent.id, toTrackedAgent(event.agent));
    this.project();
  }

  seedRoster(agents: readonly DockBadgeRosterAgent[]): void { this.applyRoster(agents); }

  forget(agentId: string): void {
    if (!this.agents.delete(agentId)) return;
    this.project();
  }

  reset(): void { this.agents.clear(); this.project(); }

  private applyRoster(agents: readonly DockBadgeRosterAgent[]): void {
    if (agents.length === 0 && this.agents.size > 0) return;
    let stampEpoch = "";
    let stampSeq = 0;
    for (const agent of agents) {
      if ((agent.snapshotSeq ?? 0) > stampSeq) { stampSeq = agent.snapshotSeq ?? 0; stampEpoch = agent.snapshotEpoch ?? ""; }
    }
    const next = new Map<string, TrackedAgent>();
    for (const agent of agents) {
      const tracked = this.agents.get(agent.id);
      next.set(agent.id, tracked != null && isStaleDockBadgeRow(tracked, agent) ? tracked : toTrackedAgent(agent));
    }
    for (const [id, tracked] of this.agents) {
      if (!next.has(id) && tracked.epoch === stampEpoch && tracked.seq > stampSeq) next.set(id, tracked);
    }
    this.agents = next;
    this.project();
  }

  private project(): void {
    const total = computeDockBadgeTotal([...this.agents.values()].map((tracked) => tracked.snapshot));
    if (total === this.projectedTotal) return;
    try { this.deps.setBadgeCount(total); this.projectedTotal = total; }
    catch (error) { this.deps.reportFailure?.("set-count", error); }
  }
}
