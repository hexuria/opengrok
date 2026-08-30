import { getMinimalJimp } from "./jimp-minimal.js";
import { decodeWebp, encodeWebp, isWebp, readWebpDimensions } from "./webp-codec.js";

export const MAX_IMAGE_DIMENSION = 1024;
export const MAX_WEBP_IMAGE_DIMENSION = 1280;
export const MAX_IMAGE_SIZE_BYTES = 1024 * 1024;

const toUint8Array = (buffer: Buffer): Uint8Array =>
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

function getMimeType(image: { mime?: string }): "image/png" | "image/bmp" | "image/tiff" | "image/x-ms-bmp" | "image/gif" | "image/jpeg" {
  switch (image.mime) {
    case "image/png": return "image/png";
    case "image/bmp": return "image/bmp";
    case "image/tiff": return "image/tiff";
    case "image/x-ms-bmp": return "image/x-ms-bmp";
    case "image/gif": return "image/gif";
    case "image/jpeg": return "image/jpeg";
    default: return "image/png";
  }
}

export function targetDimensions(width: number, height: number, maxDimension = MAX_IMAGE_DIMENSION): { width: number; height: number; needsResize: boolean } {
  let newWidth = width;
  let newHeight = height;
  if (width > height) {
    if (width > maxDimension) {
      newWidth = maxDimension;
      newHeight = Math.max(1, Math.round(height * maxDimension / width));
    }
  } else if (height > maxDimension) {
    newHeight = maxDimension;
    newWidth = Math.max(1, Math.round(width * maxDimension / height));
  }
  return { width: newWidth, height: newHeight, needsResize: newWidth !== width || newHeight !== height };
}

async function resizeWebp(imageData: Buffer): Promise<{ data: Uint8Array; mimeType: "image/webp" }> {
  const dimensions = readWebpDimensions(imageData);
  const withinCap = dimensions !== undefined && !targetDimensions(dimensions.width, dimensions.height, MAX_WEBP_IMAGE_DIMENSION).needsResize;
  if (withinCap && imageData.length <= MAX_IMAGE_SIZE_BYTES) return { data: toUint8Array(imageData), mimeType: "image/webp" };
  const decoded = await decodeWebp(imageData);
  const Jimp = await getMinimalJimp();
  const image = Jimp.fromBitmap({ data: Buffer.from(decoded.data), width: decoded.width, height: decoded.height });
  let { width, height, needsResize } = targetDimensions(image.bitmap.width, image.bitmap.height, MAX_WEBP_IMAGE_DIMENSION);
  if (needsResize) image.resize({ w: width, h: height });
  let result = await encodeWebp({ data: image.bitmap.data, width: image.bitmap.width, height: image.bitmap.height });
  while (result.length > MAX_IMAGE_SIZE_BYTES && width > 1 && height > 1) {
    width = Math.max(1, Math.round(width * 0.8));
    height = Math.max(1, Math.round(height * 0.8));
    image.resize({ w: width, h: height });
    result = await encodeWebp({ data: image.bitmap.data, width: image.bitmap.width, height: image.bitmap.height });
  }
  return { data: toUint8Array(result), mimeType: "image/webp" };
}

export async function resizeImageBufferIfNeeded(imageData: Buffer): Promise<{ data: Uint8Array; mimeType: string }> {
  if (isWebp(imageData)) return resizeWebp(imageData);
  const Jimp = await getMinimalJimp();
  const image = await Jimp.read(imageData);
  const sourceMimeType = getMimeType(image);
  const dimensions = targetDimensions(image.width, image.height);
  if (!dimensions.needsResize && imageData.length <= MAX_IMAGE_SIZE_BYTES) return { data: toUint8Array(imageData), mimeType: sourceMimeType };
  let width = dimensions.width;
  let height = dimensions.height;
  if (dimensions.needsResize) image.resize({ w: width, h: height });
  let result = await image.getBuffer(sourceMimeType);
  while (result.length > MAX_IMAGE_SIZE_BYTES && width > 1 && height > 1) {
    width = Math.max(1, Math.round(width * 0.8));
    height = Math.max(1, Math.round(height * 0.8));
    image.resize({ w: width, h: height });
    result = await image.getBuffer(sourceMimeType);
  }
  return { data: toUint8Array(result), mimeType: sourceMimeType };
}
