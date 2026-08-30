/**
 * Ported 0.27 transcript-store gates. Closed by default: opening a main-process
 * read gate changes the data path from local SQLite/file-mirror to a
 * server-backed List read. Watch and Commit exist as gated helpers; 0.27's
 * shipped main.cjs live read path is List (readTail), not Watch.
 *
 * Local override (dev / unpackaged):
 * `SAND_FEATURE_GATE_OVERRIDES=sand_transcript_store_read=1,sand_transcript_server_tail=1`
 */
export const SAND_TRANSCRIPT_SERVER_TAIL_GATE = "sand_transcript_server_tail";
export const SAND_TRANSCRIPT_STORE_READ_GATE = "sand_transcript_store_read";
export const SAND_TRANSCRIPT_STORE_FIRST_GATE = "sand_transcript_store_first";
export const SAND_TRANSCRIPT_DOUBLE_WRITE_GATE = "sand_transcript_double_write";

/** Main-process read/tail gates. 0.27 calls List from readTail when either is on. */
export const SAND_TRANSCRIPT_MAIN_READ_GATES = [
  SAND_TRANSCRIPT_SERVER_TAIL_GATE,
  SAND_TRANSCRIPT_STORE_READ_GATE,
] as const;

/**
 * Renderer-only in 0.27 (`isStoreFirstEnabled`). The host must not treat this
 * as a live List/Watch gate.
 */
export const SAND_TRANSCRIPT_RENDERER_GATES = [
  SAND_TRANSCRIPT_STORE_FIRST_GATE,
] as const;

export const SAND_TRANSCRIPT_READ_GATES = [
  ...SAND_TRANSCRIPT_MAIN_READ_GATES,
  ...SAND_TRANSCRIPT_RENDERER_GATES,
] as const;

export const SAND_TRANSCRIPT_GATES = [
  ...SAND_TRANSCRIPT_READ_GATES,
  SAND_TRANSCRIPT_DOUBLE_WRITE_GATE,
] as const;

export type SandTranscriptGateName = (typeof SAND_TRANSCRIPT_GATES)[number];
export type SandTranscriptMainReadGateName = (typeof SAND_TRANSCRIPT_MAIN_READ_GATES)[number];

export function isMainProcessTranscriptReadEnabled(gates: {
  readonly serverTail: boolean;
  readonly storeRead: boolean;
}): boolean {
  return gates.serverTail || gates.storeRead;
}

export function isStoreFirstEnabled(gates: { readonly storeFirst: boolean }): boolean {
  return gates.storeFirst;
}
