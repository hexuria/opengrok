import { isUtf8 } from "node:buffer";
import { open, readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

import * as iconv from "iconv-lite";
import * as jschardet from "jschardet";

import {
  LATIN1_ENCODING,
  UTF8_BOM_ENCODING,
  UTF8_ENCODING,
  mapToIconvEncoding,
  normalizeEncodingName,
  stripUtf8Bom,
} from "./encoding-browser.js";

enum LineEnding {
  CRLF = "CRLF",
  LF = "LF",
}

const VIDEO_EXTENSION_LIST = [".mp4", ".webm", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".m4v"] as const;
const VIDEO_EXTENSIONS = new Set<string>(VIDEO_EXTENSION_LIST);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const LATIN1_DECODER = new TextDecoder("latin1");
const MAX_FILE_ENCODINGS = 100;
const UTF8_BOM_BYTES = Buffer.from([239, 187, 191]);
const ESCAPE_BYTE = 27;
const DETECTED_UTF8_ENCODING = "UTF-8";
const FILE_TO_ENCODING = new Map<string, string>();

function getFileExtension(filePath: string): string {
  const lowerCasePath = filePath.toLowerCase();
  const lastDotIndex = lowerCasePath.lastIndexOf(".");
  if (lastDotIndex === -1) return "";
  return lowerCasePath.substring(lastDotIndex);
}

export function isVideoFilePath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(getFileExtension(filePath));
}

export async function readText(filePath: string, encodingHint?: string): Promise<string> {
  const buffer = await readFile(filePath);
  const format = getFormatForBuffer(buffer);
  if (format.isBinaryFile) throw new Error("Binary file cannot be decoded as text");
  const cachedEncoding = FILE_TO_ENCODING.get(filePath);
  const encodingToUse = encodingHint ?? cachedEncoding ?? format.encoding;
  const decoded = decodeBufferWithEncoding(buffer, encodingToUse);
  const text = stripUtf8Bom(decoded.text);
  setFileEncoding(filePath, decoded.encoding === UTF8_ENCODING && hasUtf8Bom(buffer) ? UTF8_BOM_ENCODING : decoded.encoding);
  return format.lineEnding === LineEnding.CRLF ? text.replaceAll("\r\n", "\n") : text;
}

export async function getFormatForFile(filePath: string): Promise<{
  encoding: string;
  lineEnding: LineEnding;
  isBinaryFile: boolean;
  isImageFile: boolean;
  isVideoFile: boolean;
}> {
  const header = await readFirstBytes(filePath);
  const format = getFormatForBuffer(header);
  if (!format.isBinaryFile) return { ...format, isVideoFile: false };
  return { ...format, isVideoFile: isVideoFilePath(filePath) };
}

export function countLines(data: string): number {
  if (data === "") return 1;
  let lines = 1;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === "\n") lines += 1;
  }
  return lines;
}

function getFormatForBuffer(header: Buffer): {
  encoding: string;
  lineEnding: LineEnding;
  isBinaryFile: boolean;
  isImageFile: boolean;
  isVideoFile: boolean;
} {
  if (header.length === 0) return getDefaultTextFormatForOS();
  const utf16Encoding = detectUTF16Encoding(header);
  if (utf16Encoding !== null) {
    return { encoding: utf16Encoding, lineEnding: determineLineEndingsForBuffer(header), isBinaryFile: false, isImageFile: false, isVideoFile: false };
  }
  const utf32Encoding = detectUTF32Encoding(header);
  if (utf32Encoding !== null) {
    return { encoding: utf32Encoding, lineEnding: determineLineEndingsForBuffer(header), isBinaryFile: false, isImageFile: false, isVideoFile: false };
  }
  const isBinaryFile = !isBufferText(header);
  if (isBinaryFile) {
    return { encoding: "binary", lineEnding: LineEnding.LF, isBinaryFile: true, isImageFile: isBufferAnImage(header), isVideoFile: false };
  }
  if (isUtf8(header) && !header.includes(ESCAPE_BYTE)) {
    return { encoding: DETECTED_UTF8_ENCODING, lineEnding: determineLineEndingsForBuffer(header), isBinaryFile: false, isImageFile: false, isVideoFile: false };
  }
  const detected = jschardet.detect(header);
  let encoding = detected.confidence > 0.7 ? detected.encoding : "utf-8";
  if (encoding === "ascii") encoding = "utf-8";
  return { encoding: encoding ?? "utf-8", lineEnding: determineLineEndingsForBuffer(header), isBinaryFile: false, isImageFile: false, isVideoFile: false };
}

function determineLineEndingsForBuffer(buffer: Buffer): LineEnding {
  let crlfCount = 0;
  let lfOnlyCount = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 10) {
      if (index > 0 && buffer[index - 1] === 13) crlfCount += 1;
      else lfOnlyCount += 1;
    }
  }
  if (crlfCount === 0 && lfOnlyCount === 0) return LineEnding.LF;
  return crlfCount / (crlfCount + lfOnlyCount) * 100 >= 5 ? LineEnding.CRLF : LineEnding.LF;
}

function isBufferText(buffer: Buffer): boolean {
  const length = Math.min(4096, buffer.length);
  if (length === 0) return true;
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 0) return false;
  }
  let nonPrintableCount = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index]!;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) nonPrintableCount += 1;
  }
  return nonPrintableCount / length * 100 < 5;
}

function isBufferAnImage(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true;
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return true;
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return true;
  return buffer.length >= 6 && buffer.subarray(0, 4).toString("ascii") === "GIF8" && (buffer[4] === 55 || buffer[4] === 57) && buffer[5] === 97;
}

async function readFirstBytes(filePath: string): Promise<Buffer> {
  const fileHandle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(8192);
    const { bytesRead } = await fileHandle.read(buffer, 0, 8192, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
}

function getDefaultTextFormatForOS() {
  return { encoding: UTF8_ENCODING, lineEnding: process.platform === "win32" ? LineEnding.CRLF : LineEnding.LF, isBinaryFile: false, isImageFile: false, isVideoFile: false };
}

function setFileEncoding(filePath: string, encoding: string): void {
  if (FILE_TO_ENCODING.has(filePath)) FILE_TO_ENCODING.delete(filePath);
  FILE_TO_ENCODING.set(filePath, encoding);
  if (FILE_TO_ENCODING.size <= MAX_FILE_ENCODINGS) return;
  const oldestKey = FILE_TO_ENCODING.keys().next().value;
  if (oldestKey !== undefined) FILE_TO_ENCODING.delete(oldestKey);
}

function decodeWithUtf8Fallback(buffer: Buffer): { text: string; encoding: string } {
  try { return { text: UTF8_DECODER.decode(buffer), encoding: UTF8_ENCODING }; }
  catch { return { text: LATIN1_DECODER.decode(buffer), encoding: LATIN1_ENCODING }; }
}

function decodeBufferWithEncoding(buffer: Buffer, encoding: string): { text: string; encoding: string } {
  const normalizedEncoding = normalizeEncodingName(encoding);
  if (normalizedEncoding === UTF8_ENCODING || normalizedEncoding === UTF8_BOM_ENCODING || normalizedEncoding === "ascii") {
    const decoded = decodeWithUtf8Fallback(buffer);
    if (normalizedEncoding === UTF8_BOM_ENCODING && decoded.encoding === UTF8_ENCODING) return { text: decoded.text, encoding: UTF8_BOM_ENCODING };
    return decoded;
  }
  if (normalizedEncoding === LATIN1_ENCODING) return { text: LATIN1_DECODER.decode(buffer), encoding: LATIN1_ENCODING };
  try {
    const iconvEncoding = mapToIconvEncoding(normalizedEncoding);
    if (iconv.encodingExists(iconvEncoding)) return { text: iconv.decode(buffer, iconvEncoding), encoding: normalizedEncoding };
  } catch { /* The shipped runtime falls back to UTF-8/Latin-1 on decoder failure. */ }
  return decodeWithUtf8Fallback(buffer);
}

function detectUTF16Encoding(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;
  if (buffer[0] === 255 && buffer[1] === 254 && !(buffer[2] === 0 && buffer[3] === 0)) return "UTF-16LE";
  if (buffer[0] === 254 && buffer[1] === 255) return "UTF-16BE";
  let utf16LEMatches = 0;
  let utf16BEMatches = 0;
  const samplesToCheck = Math.min(50, Math.floor(buffer.length / 2));
  for (let index = 0; index < samplesToCheck * 2; index += 2) {
    if (index + 1 >= buffer.length) break;
    if (buffer[index + 1] === 0 && isPrintable(buffer[index]!)) utf16LEMatches += 1;
    if (buffer[index] === 0 && isPrintable(buffer[index + 1]!)) utf16BEMatches += 1;
  }
  if (utf16LEMatches > samplesToCheck * 0.8) return "UTF-16LE";
  if (utf16BEMatches > samplesToCheck * 0.8) return "UTF-16BE";
  return null;
}

function isPrintable(char: number): boolean {
  return char >= 32 && char <= 126 || char === 9 || char === 10 || char === 13;
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= UTF8_BOM_BYTES.length && buffer.subarray(0, UTF8_BOM_BYTES.length).equals(UTF8_BOM_BYTES);
}

function detectUTF32Encoding(buffer: Buffer): string | null {
  if (buffer.length < 8) return null;
  if (buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 254 && buffer[3] === 255) return "UTF-32BE";
  if (buffer[0] === 255 && buffer[1] === 254 && buffer[2] === 0 && buffer[3] === 0) return "UTF-32LE";
  let utf32BEMatches = 0;
  let utf32LEMatches = 0;
  const samplesToCheck = Math.min(50, Math.floor(buffer.length / 4));
  for (let index = 0; index < samplesToCheck * 4; index += 4) {
    if (index + 3 >= buffer.length) break;
    if (buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 0 && isPrintable(buffer[index + 3]!)) utf32BEMatches += 1;
    if (buffer[index + 1] === 0 && buffer[index + 2] === 0 && buffer[index + 3] === 0 && isPrintable(buffer[index]!)) utf32LEMatches += 1;
  }
  if (utf32BEMatches > samplesToCheck * 0.8) return "UTF-32BE";
  if (utf32LEMatches > samplesToCheck * 0.8) return "UTF-32LE";
  return null;
}
