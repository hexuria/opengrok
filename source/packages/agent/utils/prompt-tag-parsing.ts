export interface TagRange { start: number; end: number; tagName: string }

function findOpenTagEnd(content: string, startIndex: number): number {
  let inQuote = false;
  for (let index = startIndex; index < content.length; index++) {
    const character = content[index];
    if (inQuote) { if (character === '"') inQuote = false; continue; }
    if (character === '"') { inQuote = true; continue; }
    if (character === ">") return index;
  }
  return -1;
}

export function extractCompleteTagRangesMatching(promptContent: string, matches: (tagName: string) => boolean): TagRange[] {
  const ranges: TagRange[] = [];
  const pattern = /<([a-zA-Z_][a-zA-Z0-9_]*)(?=[\s/>])/g;
  let searchStart = 0;
  while (searchStart < promptContent.length) {
    pattern.lastIndex = searchStart;
    const match = pattern.exec(promptContent);
    if (match === null) break;
    const openIndex = match.index;
    const tagName = match[1] as string;
    if (!matches(tagName)) { searchStart = openIndex + 1; continue; }
    const openTagEnd = findOpenTagEnd(promptContent, openIndex + 1 + tagName.length);
    if (openTagEnd === -1) break;
    const closeTag = `</${tagName}>`;
    const closeIndex = promptContent.indexOf(closeTag, openTagEnd + 1);
    if (closeIndex === -1) { searchStart = openIndex + 1; continue; }
    const end = closeIndex + closeTag.length;
    ranges.push({ start: openIndex, end, tagName });
    searchStart = end;
  }
  return ranges;
}

export function extractSelfClosingTagRangesMatching(promptContent: string, matches: (tagName: string) => boolean): TagRange[] {
  const ranges: TagRange[] = [];
  const pattern = /<([a-zA-Z_][a-zA-Z0-9_]*)(?=[\s/>])/g;
  let searchStart = 0;
  while (searchStart < promptContent.length) {
    pattern.lastIndex = searchStart;
    const match = pattern.exec(promptContent);
    if (match === null) break;
    const openIndex = match.index;
    const tagName = match[1] as string;
    if (!matches(tagName)) { searchStart = openIndex + 1; continue; }
    const openTagEnd = findOpenTagEnd(promptContent, openIndex + 1 + tagName.length);
    if (openTagEnd === -1) break;
    let lastNonWhitespaceIndex = openTagEnd - 1;
    while (lastNonWhitespaceIndex > openIndex && /\s/.test(promptContent[lastNonWhitespaceIndex] as string)) lastNonWhitespaceIndex--;
    if (promptContent[lastNonWhitespaceIndex] !== "/") { searchStart = openIndex + 1; continue; }
    const end = openTagEnd + 1;
    ranges.push({ start: openIndex, end, tagName });
    searchStart = end;
  }
  return ranges;
}

export const MCP_SERVER_TAG_NAMES = new Set(["mcp_file_system_server", "mcp_meta_tool_server", "namespace", "dynamic_tool_namespace"]);
export function isMcpServerTagName(tagName: string): boolean { return MCP_SERVER_TAG_NAMES.has(tagName); }
export function extractMcpServerTagRanges(promptContent: string): TagRange[] {
  const starts = new Set<number>();
  const ranges: TagRange[] = [];
  const add = (range: TagRange): void => { if (!starts.has(range.start)) { starts.add(range.start); ranges.push(range); } };
  for (const range of extractSelfClosingTagRangesMatching(promptContent, isMcpServerTagName)) add(range);
  for (const range of extractCompleteTagRangesMatching(promptContent, isMcpServerTagName)) add(range);
  return ranges;
}
export function extractCompleteTagRanges(promptContent: string, tagName: string): TagRange[] {
  return extractCompleteTagRangesMatching(promptContent, (candidate) => candidate === tagName);
}
