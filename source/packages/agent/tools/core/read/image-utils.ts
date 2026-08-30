import imageType from "image-type";
import mimeTypesModule from "mime-types";

interface MimeTypesModule {
  lookup(path: string): string | false;
}

const mimeTypes = mimeTypesModule as MimeTypesModule;

// Extracted from ../packages/agent/dist/tools/core/read/image-utils.js as the
// exact MIME projection leaf. The selected-context dispatcher and video paths
// remain owned by their existing modules.
export function detectImageMimeType(bytes: Uint8Array, filePath?: string): string | undefined {
  const result = imageType(bytes);
  if (result?.mime) {
    return result.mime;
  }
  if (filePath) {
    const mimeType = mimeTypes.lookup(filePath);
    if (mimeType && typeof mimeType === "string" && mimeType.startsWith("image/")) {
      return mimeType;
    }
    const extension = filePath.toLowerCase().match(/\.([^.]+)$/)?.[1];
    if (extension) {
      const fallbackMap: Readonly<Record<string, string>> = {
        avif: "image/avif",
        heic: "image/heic",
        heif: "image/heif",
      };
      if (fallbackMap[extension]) {
        return fallbackMap[extension];
      }
    }
  }
  return undefined;
}
