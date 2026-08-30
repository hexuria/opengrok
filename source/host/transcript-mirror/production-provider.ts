import { OffloadingTranscriptMirror } from "../agent-isolation/transcript-mirror-offload.js";
import { conversationBlobsPath } from "../extensions/session/conversation-blobs-path.js";
import type { HostRunnerCompositionDependencies } from "../host-runner-composition.js";
import {
  ConversationStep,
  ConversationTurnStructure,
  UserMessage,
} from "../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  createGeneratedTranscriptOccurrenceCodec,
  type GeneratedTranscriptOccurrenceBindings,
} from "./generated-occurrence-codec.js";
import {
  createTranscriptOccurrenceDeriver,
  type TranscriptOccurrenceBlobStore,
} from "./transcript-occurrence-deriver.js";
import { FileTranscriptMirror } from "./transcript-mirror.js";

type CreateTranscriptMirror = NonNullable<
  HostRunnerCompositionDependencies["createTranscriptMirror"]
>;

export interface ProductionTranscriptMirrorProviderInputs {
  /** Exact generated agent.v1 constructors and tool `toJson()` projection. */
  readonly generated: GeneratedTranscriptOccurrenceBindings;
}

function priorRootPromptCount(agentStore: unknown): number {
  const getStructure = (
    agentStore as { getConversationStateStructure?: unknown } | null
  )?.getConversationStateStructure;
  if (typeof getStructure !== "function") {
    throw new TypeError(
      "session.agentStore.getConversationStateStructure is required",
    );
  }
  const structure = getStructure.call(agentStore) as {
    rootPromptMessagesJson?: unknown;
  } | null;
  if (!Array.isArray(structure?.rootPromptMessagesJson)) {
    throw new TypeError(
      "conversation state rootPromptMessagesJson is required",
    );
  }
  return structure.rootPromptMessagesJson.length;
}

/**
 * Reconstructs host-main.cjs 667919-667934 without duplicating offload worker
 * internals. One FileTranscriptMirror journal is shared by all runners from the
 * provider, while each runner receives its own legacy prior-root cursor.
 */
export function createProductionTranscriptMirrorProvider(
  inputs: ProductionTranscriptMirrorProviderInputs,
): CreateTranscriptMirror {
  const deriver = createTranscriptOccurrenceDeriver(
    createGeneratedTranscriptOccurrenceCodec(inputs?.generated),
  );
  let transcriptJournal:
    | FileTranscriptMirror<TranscriptOccurrenceBlobStore>
    | undefined;

  return options => {
    const previousRootPromptCount = priorRootPromptCount(
      options.session.agentStore,
    );
    const blobsPath = conversationBlobsPath(options.session.dbPath);
    transcriptJournal ??= new FileTranscriptMirror(
      options.transcriptsDir,
      options.reportOutcome,
      deriver,
    );
    return transcriptJournal.routed(
      OffloadingTranscriptMirror.forTranscriptsDir(
        options.pool,
        {
          transcriptsDir: options.transcriptsDir,
          blobDbPaths: [blobsPath, options.session.dbPath],
        },
        previousRootPromptCount,
      ),
      options.isJournalEnabled,
    );
  };
}

/**
 * Production binding for the exact generated agent.v1 transcript codecs.
 * The injectable factory above remains available for isolated evidence tests;
 * production always uses the canonical protobuf-es constructor identities.
 */
export function createDefaultProductionTranscriptMirrorProvider(): CreateTranscriptMirror {
  return createProductionTranscriptMirrorProvider({
    generated: {
      ConversationTurnStructure,
      UserMessage,
      ConversationStep,
    },
  });
}
