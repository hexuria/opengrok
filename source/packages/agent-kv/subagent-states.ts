import type { ConversationStateStructure, SubagentPersistedState as SubagentPersistedStateMessage } from "../proto/generated/agent/v1/agent_pb.js";
import { SubagentPersistedState } from "../proto/generated/agent/v1/agent_pb.js";
import { createLogger } from "../context/logger.js";
import { asyncMapValues } from "../utils/promise-extras.js";
import type { BlobStore } from "./blob-store.js";
import { BlobNotFoundError } from "./blob-not-found-error.js";
import { toHex } from "./serde.js";

const SUBAGENT_STATE_BLOB_FETCH_CONCURRENCY = 8;
const logger = createLogger("@anysphere/agent-kv:subagent-states");

export async function resolveSubagentPersistedStates<Context>(
  ctx: Context,
  state: ConversationStateStructure,
  blobStore: Pick<BlobStore<Context>, "getBlob">,
): Promise<Record<string, SubagentPersistedStateMessage>> {
  const resolved: Record<string, SubagentPersistedStateMessage> = {
    ...state.subagentStates,
  };
  const refEntries = Object.entries(state.subagentStateRefs) as Array<[string, Uint8Array]>;
  if (refEntries.length === 0) return resolved;

  const loads = await asyncMapValues(
    refEntries,
    async ([subagentId, blobId]) => {
      const blob = await blobStore.getBlob(ctx, blobId);
      if (blob === undefined) {
        if (resolved[subagentId] === undefined) {
          return { kind: "missing" as const, blobIdHex: toHex(blobId) };
        }
        logger.warn(ctx as never, "Subagent state ref blob not found; falling back to inline entry", {
          subagentId,
        });
        return { kind: "fallback" as const };
      }
      try {
        return {
          kind: "loaded" as const,
          subagentId,
          state: SubagentPersistedState.fromBinary(blob),
        };
      } catch (error) {
        return { kind: "failed" as const, error };
      }
    },
    { max: SUBAGENT_STATE_BLOB_FETCH_CONCURRENCY },
  );

  const missingBlobIdHexes = loads.flatMap((load) =>
    load.kind === "missing" ? [load.blobIdHex] : [],
  );
  if (missingBlobIdHexes.length > 0) {
    throw new BlobNotFoundError(missingBlobIdHexes);
  }
  const firstFailedLoad = loads.find((load) => load.kind === "failed");
  if (firstFailedLoad?.kind === "failed") throw firstFailedLoad.error;
  for (const load of loads) {
    if (load.kind === "loaded") resolved[load.subagentId] = load.state;
  }
  return resolved;
}
