import { createContext } from "../packages/context/core.js";
import { HistoryVisibilityMode, convertConversationMessagesToTrace } from "../packages/agent-transcript/trace-format.js";
import type { ConversationMessage } from "../packages/proto/generated/aiserver/v1/chat_pb.js";
import { createSecretsExtension } from "./extensions/secrets/extension.js";
import { createStateBackstopExtension } from "./extensions/state-backstop/extension.js";
import { readStoreDbBytes } from "./extensions/state-backstop/state-backstop-service.js";
import { getSandAgentsRootDir } from "./storage/agent-paths.js";
import { checkpointSandAgentDb } from "./storage/store-db.js";

/**
 * Concrete production bindings whose complete construction is recoverable from
 * the immutable host bundle. Generated clients and context-dependent extension
 * factories deliberately do not appear here.
 */
export const productionSecretsContext:
  Parameters<typeof createSecretsExtension>[0] = createContext;

export function createProductionStateBackstop():
  Parameters<typeof createStateBackstopExtension>[0] {
  return {
    agentsRootDir: getSandAgentsRootDir(),
    readDbBytes: dbPath => readStoreDbBytes(dbPath, checkpointSandAgentDb)
  };
}

export function convertProductionCloudAgentConversationToTrace(
  conversation: unknown
): readonly unknown[] {
  return convertConversationMessagesToTrace(
    conversation as readonly ConversationMessage[],
    HistoryVisibilityMode.NO_PREAMBLE
  );
}
