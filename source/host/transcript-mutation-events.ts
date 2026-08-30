export interface TranscriptMutation { kind: string; [key: string]: unknown }
const listeners = new Set<(mutation: TranscriptMutation) => void>();
export function subscribeTranscriptMutations(listener: (mutation: TranscriptMutation) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function publishTranscriptMutation(mutation: TranscriptMutation): void { for (const listener of listeners) { try { listener(mutation); } catch {} } }
