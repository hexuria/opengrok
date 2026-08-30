import { randomUUID } from "node:crypto";
import path from "node:path";

import { sanitizeFilename } from "../utils/path-matchers.js";

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed attachment-formatting leaf. The parent processSelectedContext
// function remains absent.
export function appendRandomUploadSuffix(filename: string, fallbackFilename: string): string {
  const sanitizedFilename = sanitizeFilename(filename) || fallbackFilename;
  const suffix = randomUUID().replace(/[^a-zA-Z0-9]/g, "").slice(0, 4) || "file";
  const extension = path.extname(sanitizedFilename);
  if (extension.length === 0) {
    return `${sanitizedFilename}_${suffix}`;
  }
  const stem = sanitizedFilename.slice(0, -extension.length);
  if (stem.length === 0) {
    return `${sanitizedFilename}_${suffix}`;
  }
  return `${stem}_${suffix}${extension}`;
}
