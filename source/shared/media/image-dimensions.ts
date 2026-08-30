export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

interface IsoBox {
  readonly type: string;
  readonly body: number;
  readonly end: number;
}

function toImageDimensions({ width, height }: MediaDimensions): MediaDimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! << 8 | bytes[offset + 1]!;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 24 | bytes[offset + 1]! << 16 | bytes[offset + 2]! << 8 | bytes[offset + 3]!) >>> 0;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | bytes[offset + 1]! << 8;
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16 | bytes[offset + 3]! << 24) >>> 0;
}

function fourCharTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function indexOfFourCharTag(bytes: Uint8Array, tag: string): number {
  const t0 = tag.charCodeAt(0);
  const t1 = tag.charCodeAt(1);
  const t2 = tag.charCodeAt(2);
  const t3 = tag.charCodeAt(3);
  for (let at = 0; at + 4 <= bytes.length; at += 1) {
    if (bytes[at] === t0 && bytes[at + 1] === t1 && bytes[at + 2] === t2 && bytes[at + 3] === t3) return at;
  }
  return -1;
}

export class HeicDimensions {
  public static read(buffer: Uint8Array): MediaDimensions | null {
    if (buffer.length < 12 || fourCharTag(buffer, 4) !== "ftyp") return null;
    const selected = HeicDimensions.selectPrimary(buffer);
    if (selected == null) return null;
    const width = readU32BE(buffer, selected.ispeBody);
    const height = readU32BE(buffer, selected.ispeBody + 4);
    if (selected.quarterTurns === 1 || selected.quarterTurns === 3) {
      return toImageDimensions({ width: height, height: width });
    }
    return toImageDimensions({ width, height });
  }

  private static boxes(buffer: Uint8Array, range: { readonly start: number; readonly end: number }): IsoBox[] {
    const boxes: IsoBox[] = [];
    let offset = range.start;
    while (offset + 8 <= range.end) {
      let size = readU32BE(buffer, offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > range.end) break;
        size = readU32BE(buffer, offset + 12);
        header = 16;
      } else if (size === 0) {
        size = range.end - offset;
      }
      if (size < header || offset + size > range.end) break;
      boxes.push({ type: fourCharTag(buffer, offset + 4), body: offset + header, end: offset + size });
      offset += size;
    }
    return boxes;
  }

  private static find(boxes: readonly IsoBox[], type: string): IsoBox | undefined {
    return boxes.find((box) => box.type === type);
  }

  private static contents(box: IsoBox, skip = 0): { readonly start: number; readonly end: number } {
    return { start: box.body + skip, end: box.end };
  }

  private static primaryItemId(buffer: Uint8Array, pitm: IsoBox): number | null {
    if (pitm.body + 6 > pitm.end) return null;
    const version = buffer[pitm.body]!;
    const at = pitm.body + 4;
    if (version === 0) return readU16BE(buffer, at);
    if (at + 4 > pitm.end) return null;
    return readU32BE(buffer, at);
  }

  private static itemPropertyIndices(buffer: Uint8Array, ipma: IsoBox, itemId: number): number[] | null {
    let offset = ipma.body;
    if (offset + 8 > ipma.end) return null;
    const version = buffer[offset]!;
    const flags = buffer[offset + 1]! << 16 | buffer[offset + 2]! << 8 | buffer[offset + 3]!;
    offset += 4;
    const entryCount = readU32BE(buffer, offset);
    offset += 4;
    const idBytes = version >= 1 ? 4 : 2;
    const indexIs16 = (flags & 1) === 1;
    for (let entry = 0; entry < entryCount; entry += 1) {
      if (offset + idBytes + 1 > ipma.end) return null;
      const id = idBytes === 4 ? readU32BE(buffer, offset) : readU16BE(buffer, offset);
      offset += idBytes;
      const associations = buffer[offset]!;
      offset += 1;
      const indices: number[] = [];
      for (let association = 0; association < associations; association += 1) {
        if (indexIs16) {
          if (offset + 2 > ipma.end) return null;
          indices.push(readU16BE(buffer, offset) & 32_767);
          offset += 2;
        } else {
          if (offset + 1 > ipma.end) return null;
          indices.push(buffer[offset]! & 127);
          offset += 1;
        }
      }
      if (id === itemId) return indices;
    }
    return null;
  }

  private static selectPrimary(buffer: Uint8Array): { readonly ispeBody: number; readonly quarterTurns: number } | null {
    const firstIspe = indexOfFourCharTag(buffer, "ispe");
    const firstIrot = indexOfFourCharTag(buffer, "irot");
    const fallback = (): { readonly ispeBody: number; readonly quarterTurns: number } | null => {
      if (firstIspe < 0 || firstIspe + 16 > buffer.length) return null;
      return {
        ispeBody: firstIspe + 8,
        quarterTurns: firstIrot >= 0 && firstIrot + 4 < buffer.length ? buffer[firstIrot + 4]! & 3 : 0,
      };
    };
    const meta = HeicDimensions.find(HeicDimensions.boxes(buffer, { start: 0, end: buffer.length }), "meta");
    if (meta == null) return fallback();
    const metaBoxes = HeicDimensions.boxes(buffer, HeicDimensions.contents(meta, 4));
    const pitm = HeicDimensions.find(metaBoxes, "pitm");
    const iprp = HeicDimensions.find(metaBoxes, "iprp");
    if (pitm == null || iprp == null) return fallback();
    const iprpBoxes = HeicDimensions.boxes(buffer, HeicDimensions.contents(iprp));
    const ipco = HeicDimensions.find(iprpBoxes, "ipco");
    const ipma = HeicDimensions.find(iprpBoxes, "ipma");
    if (ipco == null || ipma == null) return fallback();
    const properties = HeicDimensions.boxes(buffer, HeicDimensions.contents(ipco));
    const primaryId = HeicDimensions.primaryItemId(buffer, pitm);
    const indices = primaryId == null ? null : HeicDimensions.itemPropertyIndices(buffer, ipma, primaryId);
    if (indices == null) return fallback();
    let ispeBody: number | null = null;
    let quarterTurns = 0;
    for (const index of indices) {
      const property = properties[index - 1];
      if (property == null) continue;
      if (property.type === "ispe" && ispeBody == null && property.body + 12 <= property.end) {
        ispeBody = property.body + 4;
      } else if (property.type === "irot" && property.body < property.end) {
        quarterTurns = buffer[property.body]! & 3;
      }
    }
    if (ispeBody == null) return fallback();
    return { ispeBody, quarterTurns };
  }
}

export function readWebpDimensions(buffer: Uint8Array): MediaDimensions | null {
  if (buffer.length < 30) return null;
  if (fourCharTag(buffer, 0) !== "RIFF" || fourCharTag(buffer, 8) !== "WEBP") return null;
  switch (fourCharTag(buffer, 12)) {
    case "VP8 ":
      return toImageDimensions({ width: readU16LE(buffer, 26) & 16_383, height: readU16LE(buffer, 28) & 16_383 });
    case "VP8L": {
      const packed = readU32LE(buffer, 21);
      return toImageDimensions({ width: (packed & 16_383) + 1, height: (packed >>> 14 & 16_383) + 1 });
    }
    case "VP8X":
      return toImageDimensions({ width: readU24LE(buffer, 24) + 1, height: readU24LE(buffer, 27) + 1 });
    default:
      return null;
  }
}

export function readWebpOrHeicDimensions(buffer: Uint8Array): MediaDimensions | null {
  return readWebpDimensions(buffer) ?? HeicDimensions.read(buffer);
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const JPEG_SEGMENTLESS_MARKERS = new Set([1, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217]);
const JPEG_NON_FRAME_MARKERS = new Set([196, 200, 204]);

export function readPngDimensions(buffer: Uint8Array): MediaDimensions | null {
  if (buffer.length < 24 || !PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)) return null;
  if (fourCharTag(buffer, 12) !== "IHDR") return null;
  return toImageDimensions({ width: readU32BE(buffer, 16), height: readU32BE(buffer, 20) });
}

export function readGifDimensions(buffer: Uint8Array): MediaDimensions | null {
  if (buffer.length < 10) return null;
  const header = String.fromCharCode(...buffer.subarray(0, 6));
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  return toImageDimensions({ width: readU16LE(buffer, 6), height: readU16LE(buffer, 8) });
}

/** EXIF orientations 5-8 are the transposed ones: browsers render those photos with width and height swapped relative to the SOF frame header. */
function readJpegExifOrientation(buffer: Uint8Array, segmentStart: number, segmentLength: number): number | null {
  const base = segmentStart + 4;
  const end = Math.min(buffer.length, segmentStart + 2 + segmentLength);
  if (base + 14 > end) return null;
  if (!(buffer[base] === 0x45 && buffer[base + 1] === 0x78 && buffer[base + 2] === 0x69 && buffer[base + 3] === 0x66 && buffer[base + 4] === 0 && buffer[base + 5] === 0)) return null;
  const tiff = base + 6;
  const little = buffer[tiff] === 0x49 && buffer[tiff + 1] === 0x49;
  if (!little && !(buffer[tiff] === 0x4d && buffer[tiff + 1] === 0x4d)) return null;
  const u16 = (at: number) => little ? readU16LE(buffer, at) : readU16BE(buffer, at);
  const u32 = (at: number) => little ? readU32LE(buffer, at) : readU32BE(buffer, at);
  if (u16(tiff + 2) !== 42) return null;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return null;
  const entryCount = u16(ifd);
  for (let index = 0; index < entryCount; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) === 0x0112) {
      const orientation = u16(entry + 8);
      return orientation >= 1 && orientation <= 8 ? orientation : null;
    }
  }
  return null;
}

export function readJpegDimensions(buffer: Uint8Array): MediaDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 255 || buffer[1] !== 216) return null;
  let offset = 2;
  let orientation: number | null = null;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 255) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    if (marker === 255) {
      offset += 1;
      continue;
    }
    if (JPEG_SEGMENTLESS_MARKERS.has(marker)) {
      offset += 2;
      continue;
    }
    if (marker === 218) return null;
    const segmentLength = readU16BE(buffer, offset + 2);
    if (segmentLength < 2) return null;
    if (marker === 225 && orientation == null) orientation = readJpegExifOrientation(buffer, offset, segmentLength);
    const isFrameHeader = marker >= 192 && marker <= 207 && !JPEG_NON_FRAME_MARKERS.has(marker);
    if (isFrameHeader) {
      if (offset + 9 > buffer.length) return null;
      const width = readU16BE(buffer, offset + 7);
      const height = readU16BE(buffer, offset + 5);
      return toImageDimensions(orientation != null && orientation >= 5 ? { width: height, height: width } : { width, height });
    }
    offset += 2 + segmentLength;
  }
  return null;
}

export function readImageFileDimensions(buffer: Uint8Array): MediaDimensions | null {
  return readWebpOrHeicDimensions(buffer)
    ?? readPngDimensions(buffer)
    ?? readGifDimensions(buffer)
    ?? readJpegDimensions(buffer);
}
