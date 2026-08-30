export interface SandUpdate { type: string; [key: string]: unknown }
export function createSandTransport(ingest: (update: SandUpdate) => string | undefined) {
  let lastSentMessageId: string | undefined; let lastReactionApplied = false;
  return { onUpdate(update: SandUpdate): void { const assignedId = ingest(update); if (update.type === "send-message") lastSentMessageId = assignedId; else if (update.type === "react-to-message") lastReactionApplied = assignedId != null; }, lastSentMessageId: () => lastSentMessageId, lastReactionApplied: () => lastReactionApplied };
}
