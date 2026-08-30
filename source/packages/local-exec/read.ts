import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { TextDecoder } from "node:util";
import * as iconv from "iconv-lite";

import type { Context } from "../context/core.js";
import { createLogger } from "../context/logger.js";
import { ReadError, ReadFileNotFound, ReadInvalidFile, ReadPermissionDenied, ReadResult, ReadSuccess } from "../proto/generated/agent/v1/read_exec_pb.js";
import { isAgentToolOutputFile, isTerminalFilePath } from "../utils/path-matchers.js";
import { resizeImageBufferIfNeeded } from "../utils/image-resize.js";
import { resolvePath } from "../utils/path-utils.js";
import { countLines, getFormatForFile, isVideoFilePath, readText } from "../utils/encoding.js";
import { scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess, type McpStateAccessor } from "./mcp-disk-freshness-on-access.js";

const PDF_EXTENSION = ".pdf";
const MAX_TEXT_SIZE = 8 * 1024 * 1024;
const STREAMING_READ_CHUNK_BYTES = 64 * 1024;
const MAX_FILE_ENCODINGS = 100;
const logger = createLogger("LocalReadExecutor");
const TERMINAL_DELIMITER = Buffer.from("\n---\n");
const TERMINAL_FOOTER_MAX_BYTES = 4096;
const TERMINAL_DETECT_MIN_PAIRED_MATCHES = 8;
const FILE_TO_ENCODING = new Map<string, string>();

const KNOWN_BINARY_MAGIC_PREFIXES = [
  Buffer.from("%PDF-", "ascii"), Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]),
  Buffer.from([80, 75, 3, 4]), Buffer.from([80, 75, 5, 6]), Buffer.from([80, 75, 7, 8]),
  Buffer.from([127, 69, 76, 70]), Buffer.from([254, 237, 250, 206]), Buffer.from([254, 237, 250, 207]),
  Buffer.from([206, 250, 237, 254]), Buffer.from([207, 250, 237, 254]), Buffer.from([77, 90, 144]),
  Buffer.from([0, 97, 115, 109]), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([255, 216, 255]),
  Buffer.from("GIF87a", "ascii"), Buffer.from("GIF89a", "ascii"), Buffer.from("SQLite format 3\0", "ascii"),
  Buffer.from([31, 139]), Buffer.from("BZh", "ascii"), Buffer.from([253, 55, 122, 88, 90, 0]),
  Buffer.from([40, 181, 47, 253]), Buffer.from([55, 122, 188, 175, 39, 28]),
  Buffer.from([82, 97, 114, 33, 26, 7, 0]), Buffer.from([82, 97, 114, 33, 26, 7, 1, 0]),
];

export interface ReadPermissions { shouldBlockRead(path: string): Promise<boolean> | boolean }
export interface LocalReadArgs { readonly path: string; readonly toolCallId?: string; readonly offset?: number; readonly limit?: number; readonly encodingHint?: string }
export interface LocalReadOptions { readonly mcpStateAccessor?: McpStateAccessor; readonly useStreamingRead?: () => Promise<boolean> }

const watchdog = async <T>(ctx: Context, message: string, milliseconds: number, operation: () => Promise<T> | T): Promise<T> => {
  const timeout = setTimeout(() => logger.warn(ctx, `[watchdog, LocalReadExecutor] ${message} still not completed after ${milliseconds}ms`), milliseconds);
  try { return await operation(); }
  finally { clearTimeout(timeout); }
};

function isPdfFilePath(filePath: string): boolean { return extname(filePath).toLowerCase() === PDF_EXTENSION; }
function printable(byte: number): boolean { return byte >= 32 && byte <= 126 || byte === 9 || byte === 10 || byte === 13; }

function terminalFrontmatterEnd(buffer: Buffer): number {
  if (buffer.length < 5 || buffer[0] !== 45 || buffer[1] !== 45 || buffer[2] !== 45 || buffer[3] !== 10) return 0;
  const index = buffer.indexOf(TERMINAL_DELIMITER, 4);
  return index === -1 ? 0 : index + TERMINAL_DELIMITER.length;
}

function terminalEncoding(body: Buffer): "utf-8" | "utf-16le" | "utf-16be" {
  if (body.length >= 2) {
    if (body[0] === 255 && body[1] === 254) return "utf-16le";
    if (body[0] === 254 && body[1] === 255) return "utf-16be";
  }
  const length = Math.min(4096, body.length);
  if (length < 16) return "utf-8";
  let littleEndian = 0;
  let bigEndian = 0;
  for (let index = 0; index + 1 < length; index += 2) {
    const low = body[index]!;
    const high = body[index + 1]!;
    if (high === 0 && printable(low)) littleEndian += 1;
    if (low === 0 && printable(high)) bigEndian += 1;
  }
  if (littleEndian >= TERMINAL_DETECT_MIN_PAIRED_MATCHES && littleEndian >= 4 * Math.max(1, bigEndian)) return "utf-16le";
  if (bigEndian >= TERMINAL_DETECT_MIN_PAIRED_MATCHES && bigEndian >= 4 * Math.max(1, littleEndian)) return "utf-16be";
  return "utf-8";
}

function validTerminalFooter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 10 && (code < 32 || code > 126)) return false;
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length < 2 || lines.length > 3) return false;
  if (!/^(exit_code: (?:-?\d+|unknown)|error: .+)$/.test(lines[0]!)) return false;
  if (!lines.at(-1)!.startsWith("ended_at: ")) return false;
  return lines.length !== 3 || /^elapsed_ms: \d+$/.test(lines[1]!);
}

function terminalFooterStart(buffer: Buffer, minimumStart: number): number {
  const length = buffer.length;
  if (length < TERMINAL_DELIMITER.length * 2 || buffer[length - 1] !== 10 || buffer[length - 2] !== 45 || buffer[length - 3] !== 45 || buffer[length - 4] !== 45 || buffer[length - 5] !== 10) return length;
  const opening = buffer.lastIndexOf(TERMINAL_DELIMITER, length - TERMINAL_DELIMITER.length - 1);
  if (opening === -1 || opening < Math.max(minimumStart, length - TERMINAL_FOOTER_MAX_BYTES)) return length;
  const footerBody = buffer.subarray(opening + TERMINAL_DELIMITER.length, length - 4).toString("utf8");
  return validTerminalFooter(footerBody) ? opening : length;
}

function decodeTerminalFile(raw: Buffer): string {
  const frontmatterEnd = terminalFrontmatterEnd(raw);
  const frontmatter = frontmatterEnd > 0 ? raw.subarray(0, frontmatterEnd).toString("utf8") : "";
  const footerStart = terminalFooterStart(raw, frontmatterEnd);
  const footer = footerStart < raw.length ? raw.subarray(footerStart).toString("utf8") : "";
  const body = raw.subarray(frontmatterEnd, footerStart);
  const encoding = terminalEncoding(body);
  let text: string;
  if (encoding === "utf-16le") text = body.toString("utf16le");
  else if (encoding === "utf-16be") {
    const swapped = Buffer.from(body.subarray(0, body.length - body.length % 2));
    swapped.swap16();
    text = swapped.toString("utf16le");
  } else text = body.toString("utf8");
  return frontmatter + (text.charCodeAt(0) === 65279 ? text.slice(1) : text) + footer;
}

function bufferStartsWith(buffer: Buffer, prefix: Buffer): boolean { return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix); }
function looksLikeKnownBinaryFormat(buffer: Buffer): boolean { return KNOWN_BINARY_MAGIC_PREFIXES.some((prefix) => bufferStartsWith(buffer, prefix)); }

function binaryRejection(path: string): ReadResult {
  const extension = extname(path).toLowerCase();
  const reason = extension === "" ? "Binary files without an extension are not supported by the read executor" : `Binary files of type ${extension} are not supported by the read executor`;
  return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path, reason }) } });
}

function applyRange(content: string, totalLines: number, args: LocalReadArgs): { content: string; rangeApplied: boolean } {
  if (args.offset === undefined && args.limit === undefined) return { content, rangeApplied: false };
  if (content === "") return { content, rangeApplied: false };
  const offset = args.offset ?? 1;
  const limit = args.limit ?? (offset < 0 ? Math.abs(offset) : totalLines);
  const start = offset < 0 ? Math.max(0, totalLines + offset) : Math.max(0, offset - 1);
  if (start >= totalLines) return { content, rangeApplied: false };
  return { content: content.split("\n").slice(start, Math.min(totalLines, start + limit)).join("\n"), rangeApplied: true };
}

function appendBounded(current: { text: string; truncated: boolean }, addition: string, maxChars = MAX_TEXT_SIZE): { text: string; truncated: boolean } {
  if (addition.length === 0) return current;
  const remaining = maxChars - current.text.length;
  if (remaining <= 0) return { text: current.text, truncated: true };
  if (addition.length > remaining) return { text: current.text + addition.slice(0, remaining), truncated: true };
  return { text: current.text + addition, truncated: current.truncated };
}

function appendRetainedLines(current: { text: string; truncated: boolean }, lines: readonly { line: { text: string; truncated: boolean }; hasNewline: boolean }[], normalizeCrlf: boolean): { text: string; truncated: boolean } {
  let result = current;
  lines.forEach((retained, index) => {
    const line = normalizeCrlf && retained.hasNewline && retained.line.text.endsWith("\r") ? { ...retained.line, text: retained.line.text.slice(0, -1) } : retained.line;
    if (index > 0) result = appendBounded(result, "\n");
    result = appendBounded(result, line.text);
    if (line.truncated) result = { text: result.text, truncated: true };
  });
  return result;
}

function cacheEncoding(path: string, encoding: string): void {
  if (FILE_TO_ENCODING.has(path)) FILE_TO_ENCODING.delete(path);
  FILE_TO_ENCODING.set(path, encoding);
  if (FILE_TO_ENCODING.size > MAX_FILE_ENCODINGS) {
    const oldest = FILE_TO_ENCODING.keys().next().value;
    if (oldest !== undefined) FILE_TO_ENCODING.delete(oldest);
  }
}

function normalizedEncoding(encoding: string): string {
  const normalized = encoding.toLowerCase();
  if (normalized === "utf-8") return "utf8";
  if (normalized === "utf-8-bom" || normalized === "utf-8 bom") return "utf8bom";
  if (normalized === "latin-1") return "latin1";
  return normalized;
}
function iconvEncoding(encoding: string): string { return normalizedEncoding(encoding) === "utf8bom" ? "utf8" : normalizedEncoding(encoding); }

class InvalidUtf8Error extends Error { constructor() { super("Invalid UTF-8 while streaming read"); this.name = "InvalidUtf8Error"; } }
type DecoderConfig = { readonly kind: "strictUtf8"; readonly cacheEncoding: string } | { readonly kind: "iconv"; readonly decoderEncoding: string; readonly cacheEncoding: string };

function streamingDecoderConfig(path: string, format: { encoding: string }, encodingHint: string | undefined): DecoderConfig {
  const requested = normalizedEncoding(encodingHint ?? FILE_TO_ENCODING.get(path) ?? format.encoding);
  const decoder = iconvEncoding(requested);
  if (decoder === "utf8") return { kind: "strictUtf8", cacheEncoding: "utf8" };
  if (iconv.encodingExists(decoder)) return { kind: "iconv", decoderEncoding: decoder, cacheEncoding: requested };
  return { kind: "strictUtf8", cacheEncoding: "utf8" };
}

async function* decodeFileChunks(ctx: Context, path: string, config: DecoderConfig): AsyncGenerator<string> {
  if (config.kind === "strictUtf8") {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const stream = createReadStream(path, { highWaterMark: STREAMING_READ_CHUNK_BYTES, signal: ctx.signal });
    try {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk as Buffer, { stream: true });
        if (text.length > 0) yield text;
      }
      const finalText = decoder.decode();
      if (finalText.length > 0) yield finalText;
    } catch (error) {
      if (error instanceof TypeError) throw new InvalidUtf8Error();
      throw error;
    }
    return;
  }
  const decoded = createReadStream(path, { highWaterMark: STREAMING_READ_CHUNK_BYTES, signal: ctx.signal }).pipe(iconv.decodeStream(config.decoderEncoding));
  for await (const chunk of decoded) yield typeof chunk === "string" ? chunk : String(chunk);
}

async function readTextStreamingWithDecoder(ctx: Context, path: string, args: LocalReadArgs, config: DecoderConfig): Promise<{ content: string; totalLines: number; truncated: boolean; rangeApplied: boolean }> {
  const hasRange = args.offset !== undefined || args.limit !== undefined;
  const negativeOffset = (args.offset ?? 1) < 0;
  const positiveStart = Math.max(0, (args.offset ?? 1) - 1);
  const positiveEnd = args.limit === undefined ? undefined : positiveStart + args.limit;
  const tailCapacity = negativeOffset ? Math.abs(args.offset ?? 1) : 0;
  const fallback: { line: { text: string; truncated: boolean }; hasNewline: boolean }[] = [];
  const selected: { line: { text: string; truncated: boolean }; hasNewline: boolean }[] = [];
  const tail: { line: { text: string; truncated: boolean }; hasNewline: boolean }[] = [];
  let fallbackBytes = 0;
  let selectedBytes = 0;
  let tailBytes = 0;
  let fallbackTruncated = false;
  let selectedTruncated = false;
  let tailTruncated = false;
  let pending = { text: "", truncated: false };
  let totalLines = 0;
  let crlfCount = 0;
  let lfCount = 0;
  let strippedBom = false;
  let hadBom = false;
  const normalizeChunk = (chunk: string): string => {
    if (strippedBom || chunk.length === 0) return chunk;
    strippedBom = true;
    if (chunk.charCodeAt(0) !== 65279) return chunk;
    hadBom = true;
    return chunk.slice(1);
  };
  const appendLine = (target: "fallback" | "selected", line: { text: string; truncated: boolean }, hasNewline: boolean): void => {
    const lines = target === "fallback" ? fallback : selected;
    const used = target === "fallback" ? fallbackBytes : selectedBytes;
    const separator = lines.length > 0 ? 1 : 0;
    let remaining = MAX_TEXT_SIZE - used;
    if (separator > 0) {
      if (remaining <= 0) {
        if (target === "fallback") fallbackTruncated = true;
        else selectedTruncated = true;
        return;
      }
      remaining -= separator;
    }
    const retained = line.text.length > remaining ? { text: line.text.slice(0, remaining), truncated: true } : line;
    lines.push({ line: retained, hasNewline });
    if (target === "fallback") { fallbackBytes += separator + retained.text.length; if (line.truncated || retained.truncated) fallbackTruncated = true; }
    else { selectedBytes += separator + retained.text.length; if (line.truncated || retained.truncated) selectedTruncated = true; }
  };
  const finishLine = (line: { text: string; truncated: boolean }, hasNewline: boolean): void => {
    if (hasNewline) {
      if (line.text.endsWith("\r")) crlfCount += 1;
      else lfCount += 1;
    }
    appendLine("fallback", line, hasNewline);
    const lineIndex = totalLines;
    if (!negativeOffset) {
      if (hasRange && lineIndex >= positiveStart && (positiveEnd === undefined || lineIndex < positiveEnd)) appendLine("selected", line, hasNewline);
    } else if (tailCapacity > 0) {
      tail.push({ line, hasNewline });
      tailBytes += line.text.length + 1;
      while (tail.length > tailCapacity) { const dropped = tail.shift(); if (dropped !== undefined) tailBytes -= dropped.line.text.length + 1; }
      while (tail.length > 1 && tailBytes > MAX_TEXT_SIZE) { const dropped = tail.shift(); if (dropped !== undefined) { tailBytes -= dropped.line.text.length + 1; tailTruncated = true; } }
    }
    totalLines += 1;
  };
  for await (const rawChunk of decodeFileChunks(ctx, path, config)) {
    const parts = normalizeChunk(rawChunk).split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      pending = appendBounded(pending, parts[index]!);
      if (index < parts.length - 1) { finishLine(pending, true); pending = { text: "", truncated: false }; }
    }
  }
  finishLine(pending, false);
  const normalizeCrlf = crlfCount + lfCount > 0 && crlfCount / (crlfCount + lfCount) * 100 >= 5;
  cacheEncoding(path, config.cacheEncoding === "utf8" && hadBom ? "utf8bom" : config.cacheEncoding);
  const full = appendRetainedLines({ text: "", truncated: fallbackTruncated }, fallback, normalizeCrlf);
  if (!hasRange) return { content: full.text, totalLines, truncated: full.truncated, rangeApplied: false };
  if (full.text === "") return { content: "", totalLines, truncated: false, rangeApplied: false };
  if (negativeOffset) {
    const limit = args.limit ?? tailCapacity;
    const result = appendRetainedLines({ text: "", truncated: tailTruncated }, tail.slice(0, limit), normalizeCrlf);
    return { content: result.text, totalLines, truncated: result.truncated, rangeApplied: true };
  }
  if (positiveStart >= totalLines) return { content: full.text, totalLines, truncated: full.truncated, rangeApplied: false };
  const result = appendRetainedLines({ text: "", truncated: selectedTruncated }, selected, normalizeCrlf);
  return { content: result.text, totalLines, truncated: result.truncated, rangeApplied: true };
}

async function readTextStreaming(ctx: Context, path: string, format: { encoding: string }, args: LocalReadArgs): Promise<{ content: string; totalLines: number; truncated: boolean; rangeApplied: boolean }> {
  const config = streamingDecoderConfig(path, format, args.encodingHint);
  try { return await readTextStreamingWithDecoder(ctx, path, args, config); }
  catch (error) {
    if (error instanceof InvalidUtf8Error) return readTextStreamingWithDecoder(ctx, path, args, { kind: "iconv", decoderEncoding: "latin1", cacheEncoding: "latin1" });
    throw error;
  }
}

export class LocalReadExecutor {
  private readonly mcpStateAccessor: McpStateAccessor | undefined;
  private readonly useStreamingRead: (() => Promise<boolean>) | undefined;
  constructor(private readonly permissionsService: ReadPermissions, private readonly workspacePath: string, options?: LocalReadOptions) {
    this.mcpStateAccessor = options?.mcpStateAccessor;
    this.useStreamingRead = options?.useStreamingRead;
  }
  async execute(ctx: Context, args: LocalReadArgs): Promise<ReadResult> {
    const path = resolvePath(args.path, this.workspacePath);
    const shouldBlock = await watchdog(ctx, "permissionsService.shouldBlockRead", 3_000, () => this.permissionsService.shouldBlockRead(path));
    if (shouldBlock) return new ReadResult({ result: { case: "permissionDenied", value: new ReadPermissionDenied({ path }) } });
    if (this.mcpStateAccessor !== undefined) scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(ctx, this.mcpStateAccessor, path);
    try {
      const stats = await watchdog(ctx, "stat", 3_000, () => stat(path));
      if (stats.isDirectory()) return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path, reason: "Path is a directory, not a file" }) } });
      if (!stats.isFile()) return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path, reason: "Path is neither a file nor a directory" }) } });
      const terminal = isTerminalFilePath(path);
      const agentTool = isAgentToolOutputFile(path);
      if (terminal || agentTool) return this.readTerminalFile(ctx, path, stats.size, args, agentTool && !terminal);
      const format = await watchdog(ctx, "getFormatForFile", 3_000, () => getFormatForFile(path));
      if (format.isImageFile) {
        const image = await watchdog(ctx, "resizeImageIfNeeded", 3_000, async () => resizeImageBufferIfNeeded(await readFile(path)));
        return new ReadResult({ result: { case: "success", value: new ReadSuccess({ path, output: { case: "data", value: image.data }, totalLines: 0, fileSize: BigInt(stats.size), truncated: false }) } });
      }
      if (isPdfFilePath(path)) {
        const data = await watchdog(ctx, "readPdfBinary", 3_000, () => readFile(path));
        return new ReadResult({ result: { case: "success", value: new ReadSuccess({ path, output: { case: "data", value: data }, totalLines: 0, fileSize: BigInt(stats.size), truncated: false }) } });
      }
      if (format.isBinaryFile && isVideoFilePath(path)) {
        const data = await watchdog(ctx, "readBinaryFile", 3_000, () => readFile(path));
        return new ReadResult({ result: { case: "success", value: new ReadSuccess({ path, output: { case: "data", value: data }, totalLines: 0, fileSize: BigInt(stats.size), truncated: false }) } });
      }
      if (format.isBinaryFile) return binaryRejection(path);
      if (this.useStreamingRead !== undefined && await watchdog(ctx, "useStreamingRead", 3_000, () => this.useStreamingRead!())) {
        const streamed = await watchdog(ctx, "readTextStreaming", 7_000, () => readTextStreaming(ctx, path, format, args));
        return new ReadResult({ result: { case: "success", value: new ReadSuccess({ path, output: { case: "content", value: streamed.content }, totalLines: streamed.totalLines, fileSize: BigInt(stats.size), truncated: streamed.truncated, rangeApplied: streamed.rangeApplied }) } });
      }
      const full = await watchdog(ctx, "readText", 3_000, () => readText(path, args.encodingHint));
      const totalLines = await watchdog(ctx, "countLines", 3_000, () => countLines(full));
      const ranged = applyRange(full, totalLines, args);
      let content = ranged.content;
      let truncated = false;
      if (content.length > MAX_TEXT_SIZE) { content = content.substring(0, MAX_TEXT_SIZE); truncated = true; }
      return new ReadResult({ result: { case: "success", value: new ReadSuccess({ path, output: { case: "content", value: content }, totalLines, fileSize: BigInt(stats.size), truncated, rangeApplied: ranged.rangeApplied }) } });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return new ReadResult({ result: { case: "fileNotFound", value: new ReadFileNotFound({ path }) } });
      if (code === "EACCES" || code === "EPERM") return new ReadResult({ result: { case: "permissionDenied", value: new ReadPermissionDenied({ path }) } });
      return new ReadResult({ result: { case: "error", value: new ReadError({ path, error: error instanceof Error ? error.message : "Unknown error occurred" }) } });
    }
  }
  private async readTerminalFile(ctx: Context, path: string, size: number, args: LocalReadArgs, checkBinary: boolean): Promise<ReadResult> {
    const raw = await watchdog(ctx, "readTerminalFile", 3_000, () => readFile(path));
    if (checkBinary && looksLikeKnownBinaryFormat(raw)) return binaryRejection(path);
    let content = decodeTerminalFile(raw).replaceAll("\r\n", "\n");
    const totalLines = countLines(content);
    const ranged = applyRange(content, totalLines, args);
    content = ranged.content;
    let truncated = false;
    if (content.length > MAX_TEXT_SIZE) { content = content.substring(0, MAX_TEXT_SIZE); truncated = true; }
    return new ReadResult({ result: { case: "success", value: new ReadSuccess({ path, output: { case: "content", value: content }, totalLines, fileSize: BigInt(size), truncated, rangeApplied: ranged.rangeApplied }) } });
  }
}
