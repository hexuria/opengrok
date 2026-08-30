const PREVIEW_TRANSFORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/`+/g, ""],
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  [/\$\$((?:[^$\\]|\\[\s\S])+)\$\$/g, "$1"],
  [/\\\(([\s\S]+?)\\\)/g, "$1"],
  [/\\\[([\s\S]+?)\\\]/g, "$1"],
  [/\\\$/g, "$"],
  [/^\s{0,3}#{1,6}\s+/gm, ""],
  [/^\s{0,3}>\s?/gm, ""],
  [/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, ""],
  [/\*\*([^*]+)\*\*/g, "$1"],
  [/__([^_]+)__/g, "$1"],
  [/~~([^~]+)~~/g, "$1"],
  [/\*([^*\n]+)\*/g, "$1"],
  [/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1"],
  [/\|/g, " "],
];

export function markdownToPreviewText(input: string): string {
  const flattened = PREVIEW_TRANSFORMS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    input,
  );
  return flattened.replace(/\s+/g, " ").trim();
}
