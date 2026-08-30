export interface BranchedTranscriptEntry {
  readonly id: string;
  readonly replyTo?: string;
  readonly [key: string]: unknown;
}

function replyToOf(entry: BranchedTranscriptEntry): string | undefined {
  return "replyTo" in entry ? entry.replyTo : undefined;
}

function resolveBranchRoot(
  entry: BranchedTranscriptEntry,
  branchedById: ReadonlyMap<string, BranchedTranscriptEntry>,
): string | undefined {
  let current = entry;
  const seen = new Set([entry.id]);
  for (;;) {
    const parentId = replyToOf(current);
    if (parentId === undefined) return undefined;
    const parent = branchedById.get(parentId);
    if (parent === undefined) return parentId;
    if (seen.has(parentId)) return undefined;
    seen.add(parentId);
    current = parent;
  }
}

export function branchReplyCounts(
  branched: readonly BranchedTranscriptEntry[],
): Map<string, number> {
  const byId = new Map(branched.map((entry) => [entry.id, entry]));
  const counts = new Map<string, number>();
  for (const entry of branched) {
    const root = resolveBranchRoot(entry, byId);
    if (root === undefined) continue;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}

export function threadDescendants<T extends BranchedTranscriptEntry>(
  rootId: string,
  branched: readonly T[],
): T[] {
  const byId = new Map<string, BranchedTranscriptEntry>(
    branched.map((entry) => [entry.id, entry]),
  );
  return branched.filter((entry) => resolveBranchRoot(entry, byId) === rootId);
}
