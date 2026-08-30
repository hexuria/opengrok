import type { Context } from "../context/core.js";
import { createSpan } from "../context/otel.js";
import { clampInt32 } from "./int32.js";

export interface ParsedGrepFilesOutput {
  readonly files: string[];
  readonly totalFiles: number;
  readonly clientTruncated: boolean;
  readonly ripgrepTruncated: boolean;
}

export interface ParsedGrepCount {
  readonly file: string;
  readonly count: number;
}

export interface ParsedGrepCountOutput {
  readonly counts: ParsedGrepCount[];
  readonly totalFiles: number;
  readonly totalMatches: number;
  readonly clientTruncated: boolean;
  readonly ripgrepTruncated: boolean;
}

export interface ParsedGrepContentMatch {
  readonly lineNumber: number;
  readonly content: string;
  readonly isContextLine: boolean;
}

export interface ParsedGrepContentFile {
  readonly file: string;
  readonly matches: ParsedGrepContentMatch[];
}

export interface ParsedGrepContentOutput {
  readonly byFile: Map<string, ParsedGrepContentFile>;
  readonly totalLines: number;
  readonly totalMatchedLines: number;
  readonly totalFiles: number;
  readonly clientTruncated: boolean;
  readonly ripgrepTruncated: boolean;
}

export function splitGrepLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export function parseGrepFilesOutput(stdout: string, clientLimitLines: number, ripgrepHardCuttoffLines: number): ParsedGrepFilesOutput {
  const trimmed = stdout.trim();
  const lines = trimmed !== "" ? splitGrepLines(trimmed) : [];
  const totalFiles = lines.length;
  const sliced = lines.slice(0, clientLimitLines);
  return {
    files: sliced,
    totalFiles: clampInt32(totalFiles),
    clientTruncated: lines.length > clientLimitLines,
    ripgrepTruncated: totalFiles >= ripgrepHardCuttoffLines,
  };
}

export function parseGrepCountOutput(stdout: string, clientLimitLines: number, ripgrepHardCuttoffLines: number): ParsedGrepCountOutput {
  const trimmed = stdout.trim();
  const lines = trimmed !== "" ? splitGrepLines(trimmed) : [];
  const allCounts: ParsedGrepCount[] = [];
  for (const line of lines) {
    if (line === "" || line === undefined) continue;
    const colonIndex = line.lastIndexOf(":");
    if (colonIndex <= 0) continue;
    const parsedCount = Number.parseInt(line.substring(colonIndex + 1).trim(), 10);
    if (!Number.isFinite(parsedCount)) continue;
    allCounts.push({ file: line.substring(0, colonIndex), count: parsedCount });
  }
  const totalFiles = allCounts.length;
  const totalMatches = allCounts.reduce((total, entry) => total + entry.count, 0);
  const sliced = allCounts.slice(0, clientLimitLines);
  return {
    counts: sliced,
    totalFiles: clampInt32(totalFiles),
    totalMatches: clampInt32(totalMatches),
    clientTruncated: allCounts.length > clientLimitLines,
    ripgrepTruncated: totalFiles >= ripgrepHardCuttoffLines,
  };
}

export function parseGrepContentOutput(stdout: string, clientLimitLines: number, ripgrepHardCuttoffLines: number, ctx: Context): ParsedGrepContentOutput {
  using span = createSpan(ctx.withName("parseContentOutput"));
  const lines = stdout.trim() === "" ? [] : splitGrepLines(stdout);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const byFile = new Map<string, ParsedGrepContentFile>();
  const allFiles = new Set<string>();
  let totalMatchedLines = 0;
  let linesProcessed = 0;
  for (const line of lines) {
    if (line === undefined || line === "--") continue;
    const [filename, lineContent] = line.split("\0", 2);
    if (filename === undefined || lineContent === undefined) continue;
    const match = /^(\d+)([:-])(.*)$/.exec(lineContent);
    if (match === null) continue;
    const lineNumber = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(lineNumber)) continue;
    const isContextLine = match[2] === "-";
    if (!isContextLine) totalMatchedLines++;
    allFiles.add(filename);
    if (linesProcessed >= clientLimitLines) continue;
    const fileResults = byFile.get(filename) ?? { file: filename, matches: [] };
    fileResults.matches.push({ lineNumber, content: match[3] ?? "", isContextLine });
    byFile.set(filename, fileResults);
    linesProcessed++;
  }
  const totalFiles = allFiles.size;
  return {
    byFile,
    totalLines: clampInt32(lines.length),
    totalMatchedLines: clampInt32(totalMatchedLines),
    totalFiles: clampInt32(totalFiles),
    clientTruncated: linesProcessed >= clientLimitLines,
    ripgrepTruncated: lines.length >= ripgrepHardCuttoffLines,
  };
}
