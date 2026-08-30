import { readGifDimensions, readJpegDimensions, readPngDimensions, readWebpOrHeicDimensions } from "../../../shared/media/image-dimensions.js";

export interface ImageSize { readonly width: number; readonly height: number }
export interface PreviewImageBounds { readonly maxDimension: number; readonly encoding: unknown }
export const LINK_PREVIEW_MAX_DECODE_PIXELS = 24_000_000;
const DIB_HEADER_SIZES = new Set([40, 52, 56, 108, 124]);

function readIcoBitmapSize(bytes: Buffer, offset: number): ImageSize | null {
  if (offset + 12 > bytes.length || !DIB_HEADER_SIZES.has(bytes.readUInt32LE(offset))) return null;
  const width = bytes.readInt32LE(offset + 4);
  const height = Math.ceil(Math.abs(bytes.readInt32LE(offset + 8)) / 2);
  return width > 0 && height > 0 ? { width, height } : null;
}
export function readIcoSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0) return null;
  const kind = bytes.readUInt16LE(2), entries = bytes.readUInt16LE(4);
  if ((kind !== 1 && kind !== 2) || entries === 0 || bytes.length < 6 + entries * 16) return null;
  let largest: ImageSize | null = null, largestPixels = 0;
  for (let index = 0; index < entries; index += 1) {
    const entry = 6 + index * 16, payload = bytes.readUInt32LE(entry + 12);
    const side = (value: number | undefined) => value === 0 ? 256 : value ?? 0;
    for (const candidate of [{ width: side(bytes[entry]), height: side(bytes[entry + 1]) }, payload < bytes.length ? readPngDimensions(bytes.subarray(payload)) : null, readIcoBitmapSize(bytes, payload)]) {
      if (candidate == null) continue;
      const pixels = candidate.width * candidate.height;
      if (pixels > largestPixels) { largestPixels = pixels; largest = candidate; }
    }
  }
  return largest;
}
export function decodeBase64DataUrl(dataUrl: string): Buffer | null {
  if (!dataUrl.startsWith("data:")) return null;
  const separator = dataUrl.indexOf(",");
  if (separator < 0 || !dataUrl.slice(0, separator).endsWith(";base64")) return null;
  return Buffer.from(dataUrl.slice(separator + 1), "base64");
}
export function readEncodedImageSize(dataUrl: string): ImageSize | null {
  const bytes = decodeBase64DataUrl(dataUrl);
  if (bytes == null) return null;
  for (const read of [readPngDimensions, readJpegDimensions, readGifDimensions, readIcoSize, readWebpOrHeicDimensions]) {
    const size = read(bytes); if (size != null && size.width > 0 && size.height > 0) return size;
  }
  return null;
}
export function boundPreviewImageDataUrl(dataUrl: string | null, bounds: PreviewImageBounds, resize: (dataUrl: string, target: { width: number } | { height: number }, encoding: unknown) => string | null): string | null {
  if (dataUrl == null) return null;
  const size = readEncodedImageSize(dataUrl);
  if (size == null || size.width * size.height > LINK_PREVIEW_MAX_DECODE_PIXELS) return null;
  if (Math.max(size.width, size.height) <= bounds.maxDimension) return dataUrl;
  const target = size.width >= size.height ? { width: bounds.maxDimension } : { height: bounds.maxDimension };
  return resize(dataUrl, target, bounds.encoding) ?? dataUrl;
}
