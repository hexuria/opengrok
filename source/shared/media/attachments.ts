export const SAND_ATTACHMENT_KINDS = [
  "image", "video", "audio", "pdf", "markdown", "table", "json", "text", "document", "archive", "file",
] as const;

export type SandAttachmentKind = (typeof SAND_ATTACHMENT_KINDS)[number];
export interface AttachmentKindCount { readonly kind: string; readonly count: number }

const KIND_LABELS: Readonly<Record<SandAttachmentKind, { readonly singular: string; readonly plural: string }>> = {
  image: { singular: "image", plural: "images" },
  video: { singular: "video", plural: "videos" },
  audio: { singular: "audio file", plural: "audio files" },
  pdf: { singular: "PDF", plural: "PDFs" },
  markdown: { singular: "Markdown file", plural: "Markdown files" },
  table: { singular: "spreadsheet", plural: "spreadsheets" },
  json: { singular: "JSON file", plural: "JSON files" },
  text: { singular: "text file", plural: "text files" },
  document: { singular: "document", plural: "documents" },
  archive: { singular: "archive", plural: "archives" },
  file: { singular: "file", plural: "files" },
};

export function kindPhrase(kind: SandAttachmentKind, count: number): string {
  const label = KIND_LABELS[kind];
  return `${count} ${count === 1 ? label.singular : label.plural}`;
}

export function mergeKindCounts(kinds: readonly AttachmentKindCount[] | null | undefined): Array<{ kind: SandAttachmentKind; count: number }> {
  if (kinds == null || kinds.length === 0) return [];
  const known = kinds
    .filter((entry) => entry.count > 0)
    .map((entry) => Object.hasOwn(KIND_LABELS, entry.kind)
      ? { kind: entry.kind as SandAttachmentKind, count: entry.count }
      : { kind: "file" as const, count: entry.count });
  const merged = new Map<SandAttachmentKind, number>();
  for (const entry of known) merged.set(entry.kind, (merged.get(entry.kind) ?? 0) + entry.count);
  return [...merged].map(([kind, count]) => ({ kind, count }));
}

export function formatAttachmentSentSummary(count: number, kinds?: readonly AttachmentKindCount[] | null): string {
  const total = Math.max(1, Math.floor(count));
  const merged = mergeKindCounts(kinds);
  if (merged.length === 0) return `Sent ${kindPhrase("file", total)}`;
  const first = merged[0];
  if (merged.length === 1 && first != null) return `Sent ${kindPhrase(first.kind, total)}`;
  const breakdown = merged.map((entry) => kindPhrase(entry.kind, entry.count)).join(", ");
  return `Sent ${kindPhrase("file", total)} · ${breakdown}`;
}
