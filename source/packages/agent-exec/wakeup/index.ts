export interface Wakeup { conversationId: string; id: string; groupKey?: string; [key: string]: unknown }

export function mergeWakeup<T extends Wakeup>(queue: readonly T[], incoming: T): { queue: T[]; replaced?: T } {
  if (queue.some((wakeup) => wakeup.conversationId === incoming.conversationId && wakeup.id === incoming.id)) {
    return { queue: [...queue] };
  }
  const ownedIncoming = { ...incoming };
  if (incoming.groupKey === undefined) return { queue: [...queue, ownedIncoming] };
  const groupedIndex = queue.findIndex((wakeup) => wakeup.conversationId === incoming.conversationId && wakeup.groupKey === incoming.groupKey);
  if (groupedIndex === -1) return { queue: [...queue, ownedIncoming] };
  const merged = [...queue];
  const replaced = merged[groupedIndex];
  merged[groupedIndex] = ownedIncoming;
  return replaced === undefined ? { queue: merged } : { queue: merged, replaced };
}
