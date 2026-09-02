/**
 * The filter bar's language: one field, three kinds of token.
 *
 * `#tag` matches a collection's tags, `@group` its group, and anything else its name. Several
 * tags, or several groups, widen the search — "either of these" is what a chip bar means. Words
 * narrow it: typing "mom jokes" looks for a name with both, the way search does everywhere else.
 * Kinds always narrow each other: this group AND that tag AND those words.
 *
 * Pure, so the window and its tests agree without a DOM between them.
 */

export type CollectionFilterKind = "tag" | "group" | "text";

export interface CollectionFilterToken {
  readonly kind: CollectionFilterKind;
  /** As typed, for the chip's label. */
  readonly value: string;
}

export interface CollectionFilterable {
  readonly name: string;
  readonly group?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

/** `#math` → a tag token, `@research` → a group token, `jokes` → text. A bare sigil is nothing. */
export function parseCollectionFilterToken(raw: string): CollectionFilterToken | null {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  const sigil = trimmed[0];
  const rest = trimmed.slice(1).trim();
  if (sigil === "#") return rest.length === 0 ? null : { kind: "tag", value: rest };
  if (sigil === "@") return rest.length === 0 ? null : { kind: "group", value: rest };
  return { kind: "text", value: trimmed };
}

/** Splits a typed line into tokens, so a pasted "@research #math jokes" becomes three chips. */
export function parseCollectionFilter(line: string): CollectionFilterToken[] {
  const tokens: CollectionFilterToken[] = [];
  for (const piece of line.split(/\s+/)) {
    const token = parseCollectionFilterToken(piece);
    if (token != null) tokens.push(token);
  }
  return tokens;
}

const fold = (value: string): string => value.toLocaleLowerCase();

function matchesKind(collection: CollectionFilterable, kind: CollectionFilterKind, values: readonly string[]): boolean {
  if (values.length === 0) return true;
  if (kind === "group") {
    const group = fold(collection.group ?? "");
    return values.some((value) => group === fold(value));
  }
  if (kind === "tag") {
    const tags = (collection.tags ?? []).map(fold);
    return values.some((value) => tags.includes(fold(value)));
  }
  const name = fold(collection.name);
  // Every word must land: "mom jokes" finds "Mom's jokes" and not "Dad jokes".
  return values.every((value) => fold(value).split(" ").every((word) => name.includes(word)));
}

export function collectionMatchesFilter(collection: CollectionFilterable, tokens: readonly CollectionFilterToken[]): boolean {
  if (tokens.length === 0) return true;
  const of = (kind: CollectionFilterKind): string[] => tokens.filter((token) => token.kind === kind).map((token) => token.value);
  return matchesKind(collection, "group", of("group"))
    && matchesKind(collection, "tag", of("tag"))
    && matchesKind(collection, "text", of("text"));
}

export function filterCollections<T extends CollectionFilterable>(collections: readonly T[], tokens: readonly CollectionFilterToken[]): T[] {
  return collections.filter((collection) => collectionMatchesFilter(collection, tokens));
}

/** Group headings in the order the sidebar shows them: named groups by name, then the ungrouped. */
export const UNGROUPED_HEADING = "Collections";

export function groupCollections<T extends CollectionFilterable>(collections: readonly T[]): { readonly heading: string; readonly collections: T[] }[] {
  const groups = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const collection of collections) {
    const group = (collection.group ?? "").trim();
    if (group.length === 0) { ungrouped.push(collection); continue; }
    const existing = groups.get(group);
    if (existing == null) groups.set(group, [collection]); else existing.push(collection);
  }
  const sections = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([heading, items]) => ({ heading, collections: items }));
  if (ungrouped.length > 0) sections.push({ heading: UNGROUPED_HEADING, collections: ungrouped });
  return sections;
}

/** Every group and tag in use, for suggesting what can be typed. */
export function collectionFilterVocabulary(collections: readonly CollectionFilterable[]): { readonly groups: string[]; readonly tags: string[] } {
  // One label per spelling-insensitive name, shown as it was first written.
  const groups = new Map<string, string>();
  const tags = new Map<string, string>();
  const remember = (into: Map<string, string>, raw: string): void => {
    const value = raw.trim();
    if (value.length > 0 && !into.has(fold(value))) into.set(fold(value), value);
  };
  for (const collection of collections) {
    remember(groups, collection.group ?? "");
    for (const tag of collection.tags ?? []) remember(tags, tag);
  }
  const sorted = (into: Map<string, string>): string[] => [...into.values()].sort((a, b) => fold(a).localeCompare(fold(b)));
  return { groups: sorted(groups), tags: sorted(tags) };
}
