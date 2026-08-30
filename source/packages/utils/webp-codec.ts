export interface WebpBitmap {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface WebpCodec {
  decode(data: Buffer): Promise<WebpBitmap> | WebpBitmap;
  encode(bitmap: WebpBitmap): Promise<Buffer> | Buffer;
}

let registeredCodec: WebpCodec | undefined;

export function registerWebpCodec(codec: WebpCodec): void {
  registeredCodec = codec;
}

function requireCodec(): WebpCodec {
  if (registeredCodec === undefined) {
    throw new Error("webp codec not registered: registerWebpCodec() must be called by a Node server before decoding/encoding webp");
  }
  return registeredCodec;
}

export function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

export function readWebpDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (!isWebp(buffer) || buffer.length < 16) return undefined;
  const fourCC = buffer.toString("ascii", 12, 16);
  if (fourCC === "VP8 ") {
    if (buffer.length < 30 || buffer[23] !== 157 || buffer[24] !== 1 || buffer[25] !== 42) return undefined;
    return { width: ((buffer[26] ?? 0) | (buffer[27] ?? 0) << 8) & 16383, height: ((buffer[28] ?? 0) | (buffer[29] ?? 0) << 8) & 16383 };
  }
  if (fourCC === "VP8L") {
    if (buffer.length < 25 || buffer[20] !== 47) return undefined;
    const bits = ((buffer[21] ?? 0) | (buffer[22] ?? 0) << 8 | (buffer[23] ?? 0) << 16 | (buffer[24] ?? 0) << 24) >>> 0;
    return { width: (bits & 16383) + 1, height: (bits >> 14 & 16383) + 1 };
  }
  if (fourCC === "VP8X") {
    if (buffer.length < 30) return undefined;
    return {
      width: 1 + ((buffer[24] ?? 0) | (buffer[25] ?? 0) << 8 | (buffer[26] ?? 0) << 16),
      height: 1 + ((buffer[27] ?? 0) | (buffer[28] ?? 0) << 8 | (buffer[29] ?? 0) << 16),
    };
  }
  return undefined;
}

export const decodeWebp = (data: Buffer): Promise<WebpBitmap> | WebpBitmap => requireCodec().decode(data);
export const encodeWebp = (bitmap: WebpBitmap): Promise<Buffer> | Buffer => requireCodec().encode(bitmap);
