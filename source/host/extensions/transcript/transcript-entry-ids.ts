import type { TranscriptEntry } from "./transcript-hub.js";
export const BOOT_TURN = "b";
export type TranscriptEntryIdKind =
  "user-message" | "user-attachment" | "assistant-message" | "send-message";
export function nextEntryId(
  entries: readonly TranscriptEntry[],
  kind: TranscriptEntryIdKind,
  retiredIds?: ReadonlySet<string>,
): string {
  const ids = new Set(entries.map((e) => e.id)),
    users = countUserMessages(entries);
  if (retiredIds != null) for (const retired of retiredIds) ids.add(retired);
  if (kind === "user-message")
    return firstUnusedId(ids, (n) => `t${n}u`, users);
  if (kind === "user-attachment")
    return firstUnusedId(
      ids,
      (n) => `t${users}ua${n}`,
      countTrailingUserAttachments(entries),
    );
  const turn = users === 0 ? BOOT_TURN : users - 1;
  return kind === "assistant-message"
    ? firstUnusedId(
        ids,
        (n) => `t${turn}a${n}`,
        countTrailingAssistantMessages(entries),
      )
    : firstUnusedId(
        ids,
        (n) => `t${turn}s${n}`,
        countTrailingSendMessages(entries),
      );
}
export function firstUnusedId(
  existingIds: ReadonlySet<string>,
  mint: (index: number) => string,
  startIndex: number,
): string {
  let index = startIndex,
    id = mint(index);
  while (existingIds.has(id)) id = mint(++index);
  return id;
}
export function countUserMessages(entries: readonly TranscriptEntry[]): number {
  return entries.reduce(
    (n, e) => n + (e.kind === "message" && e.role === "user" ? 1 : 0),
    0,
  );
}
function countTrailing(
  entries: readonly TranscriptEntry[],
  predicate: (entry: TranscriptEntry) => boolean,
): number {
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry == null) continue;
    if (entry.kind === "message" && entry.role === "user") break;
    if (predicate(entry)) count++;
  }
  return count;
}
export function countTrailingUserAttachments(
  entries: readonly TranscriptEntry[],
): number {
  return countTrailing(entries, (e) => e.kind === "user-attachment");
}
export function countTrailingAssistantMessages(
  entries: readonly TranscriptEntry[],
): number {
  return countTrailing(
    entries,
    (e) => e.kind === "message" && e.role === "assistant",
  );
}
export function countTrailingSendMessages(
  entries: readonly TranscriptEntry[],
): number {
  return countTrailing(entries, (e) => e.kind === "send-message");
}
