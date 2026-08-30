// Exact dependency-closed PDF classifier recovered from the Mac/Windows host
// carrier's pdf-utils owner. The worker-pool portion remains intentionally
// unbound until the retained pdf-worker payload and Piscina package close.
const PDF_HEADER = [37, 80, 68, 70] as const;
const PDF_EXTENSION_REGEX = /\.pdf$/i;

export function hasPdfMagicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_HEADER.length) {
    return false;
  }
  return PDF_HEADER.every((value, index) => bytes[index] === value);
}

export function isPdfBinary(bytes: Uint8Array, filePath?: string): boolean {
  if (hasPdfMagicBytes(bytes)) {
    return true;
  }
  if (filePath && PDF_EXTENSION_REGEX.test(filePath)) {
    return true;
  }
  return false;
}
