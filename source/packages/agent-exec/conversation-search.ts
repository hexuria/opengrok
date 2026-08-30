import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { ConversationSearchArgs, ConversationSearchResult } from "../proto/generated/agent/v1/conversation_search_exec_pb.js";

export const conversationSearchExecutorResource = createResource<Executor<ConversationSearchArgs, ConversationSearchResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("conversationSearchArgs"), createClientDeserializer("conversationSearchResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("conversationSearchArgs"), createClientSerializer("conversationSearchResult"))),
);
