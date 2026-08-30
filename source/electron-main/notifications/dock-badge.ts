export interface DockBadgeAgent {
  readonly hasUnread?: boolean;
  readonly isHiddenFromSidebar?: boolean;
  readonly unreadCount?: number | null;
}

export function computeDockBadgeTotal(agents: readonly DockBadgeAgent[]): number {
  let total = 0;
  for (const agent of agents) {
    if (!agent.hasUnread || agent.isHiddenFromSidebar) continue;
    total += Math.max(Math.floor(agent.unreadCount ?? 1), 1);
  }
  return total;
}
