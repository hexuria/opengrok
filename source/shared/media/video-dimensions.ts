import type { MediaDimensions } from "./image-dimensions.js";

interface ByteRange { readonly start: number; readonly end: number }
interface ClampedBox { readonly body: ByteRange; readonly next: number }

function toDimensions({ width, height }: MediaDimensions): MediaDimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 24 | bytes[offset + 1]! << 16 | bytes[offset + 2]! << 8 | bytes[offset + 3]!) >>> 0;
}

function fourCharTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

export class Mp4Dimensions {
  public static read(window: Uint8Array): MediaDimensions | null {
    let searchFrom = 0;
    while (searchFrom + 4 <= window.length) {
      const moovTag = Mp4Dimensions.indexOfTag(window, "moov", searchFrom);
      if (moovTag < 0) return null;
      const dimensions = Mp4Dimensions.readMoov(window, moovTag);
      if (dimensions != null) return dimensions;
      searchFrom = moovTag + 4;
    }
    return null;
  }

  private static indexOfTag(bytes: Uint8Array, tag: string, from: number): number {
    const t0 = tag.charCodeAt(0);
    const t1 = tag.charCodeAt(1);
    const t2 = tag.charCodeAt(2);
    const t3 = tag.charCodeAt(3);
    for (let at = Math.max(from, 4); at + 4 <= bytes.length; at += 1) {
      if (bytes[at] === t0 && bytes[at + 1] === t1 && bytes[at + 2] === t2 && bytes[at + 3] === t3) return at;
    }
    return -1;
  }

  private static readMoov(bytes: Uint8Array, moovTag: number): MediaDimensions | null {
    const box = Mp4Dimensions.clampedBoxAt(bytes, { at: moovTag - 4, end: bytes.length });
    if (box == null) return null;
    for (const trak of Mp4Dimensions.childBoxes(bytes, box.body, "trak")) {
      for (const tkhd of Mp4Dimensions.childBoxes(bytes, trak, "tkhd")) {
        const dimensions = Mp4Dimensions.readTkhd(bytes, tkhd);
        if (dimensions != null) return dimensions;
      }
    }
    return null;
  }

  private static clampedBoxAt(bytes: Uint8Array, input: { readonly at: number; readonly end: number }): ClampedBox | null {
    if (input.at < 0 || input.at + 8 > input.end) return null;
    let size = readU32BE(bytes, input.at);
    let header = 8;
    if (size === 1) {
      if (input.at + 16 > input.end) return null;
      size = readU32BE(bytes, input.at + 12);
      header = 16;
    } else if (size === 0) {
      size = input.end - input.at;
    }
    if (size < header) return null;
    return {
      body: { start: input.at + header, end: Math.min(input.at + size, input.end) },
      next: input.at + size,
    };
  }

  private static childBoxes(bytes: Uint8Array, range: ByteRange, type: string): ByteRange[] {
    const children: ByteRange[] = [];
    let offset = range.start;
    while (offset + 8 <= range.end) {
      const box = Mp4Dimensions.clampedBoxAt(bytes, { at: offset, end: range.end });
      if (box == null) break;
      if (fourCharTag(bytes, offset + 4) === type) children.push(box.body);
      if (box.next > range.end) break;
      offset = box.next;
    }
    return children;
  }

  private static readTkhd(bytes: Uint8Array, box: ByteRange): MediaDimensions | null {
    if (box.start >= box.end) return null;
    const version = bytes[box.start]!;
    const widenedTimestamps = version === 1 ? 12 : 0;
    const matrixAt = box.start + 40 + widenedTimestamps;
    const widthAt = matrixAt + 36;
    if (widthAt + 8 > box.end) return null;
    const width = Mp4Dimensions.read16Dot16(bytes, widthAt);
    const height = Mp4Dimensions.read16Dot16(bytes, widthAt + 4);
    if (Mp4Dimensions.matrixIsQuarterTurn(bytes, matrixAt)) return toDimensions({ width: height, height: width });
    return toDimensions({ width, height });
  }

  private static read16Dot16(bytes: Uint8Array, offset: number): number {
    return readU32BE(bytes, offset) >>> 16;
  }

  private static matrixIsQuarterTurn(bytes: Uint8Array, matrixAt: number): boolean {
    const a = readU32BE(bytes, matrixAt);
    const b = readU32BE(bytes, matrixAt + 4);
    const c = readU32BE(bytes, matrixAt + 12);
    const d = readU32BE(bytes, matrixAt + 16);
    return a === 0 && d === 0 && b !== 0 && c !== 0;
  }
}
