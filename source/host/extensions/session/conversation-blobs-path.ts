import { dirname, join } from "node:path";

import { CONVERSATION_BLOBS_FILENAME } from "./session-paths.js";

/**
 * Exact session API path construction from host-main.cjs:633488.
 */
export function conversationBlobsPath(dbPath: string): string {
  return join(dirname(dbPath), CONVERSATION_BLOBS_FILENAME);
}
