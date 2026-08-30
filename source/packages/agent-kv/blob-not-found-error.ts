const CONVERSATION_DATA_MISSING_MESSAGE = "This conversation's data is missing and can't be restored. Start a new chat to continue.";
const MAX_MESSAGE_BLOB_ID_HEXES = 3;
const MESSAGE_BLOB_ID_HEX_LENGTH = 12;
const MAX_CAUSE_CHAIN_DEPTH = 10;

function formatMissingBlobSuffix(blobIdHexes: readonly string[]): string {
  if (blobIdHexes.length === 0) return "";
  const shown = blobIdHexes.slice(0, MAX_MESSAGE_BLOB_ID_HEXES).map((hex) => hex.slice(0, MESSAGE_BLOB_ID_HEX_LENGTH));
  const label = blobIdHexes.length === 1
    ? `missing blob ${shown[0]}`
    : `${blobIdHexes.length} missing blobs: ${shown.join(", ")}${blobIdHexes.length > shown.length ? ", …" : ""}`;
  return ` (${label})`;
}

export class BlobNotFoundError extends Error {
  readonly isUsageError = true;
  readonly isBlobNotFound = true;
  readonly blobIdHexes: string[];
  constructor(blobIdHexes: readonly string[], options?: { cause?: unknown }) {
    super(`${CONVERSATION_DATA_MISSING_MESSAGE}${formatMissingBlobSuffix(blobIdHexes)}`, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BlobNotFoundError";
    this.blobIdHexes = [...blobIdHexes];
  }
}
function isBlobNotFoundErrorNode(error: unknown): error is Error {
  return error instanceof Error && (error instanceof BlobNotFoundError || (error as Error & { isBlobNotFound?: boolean }).isBlobNotFound === true || error.name === "BlobNotFoundError");
}
export function findBlobNotFoundError(error: unknown): Error | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH; depth++) {
    if (current === null || current === undefined) return undefined;
    if (isBlobNotFoundErrorNode(current)) return current;
    if (typeof current !== "object" || !("cause" in current)) return undefined;
    current = current.cause;
  }
  return undefined;
}
