import type {
  DecodedTranscriptStep,
  DecodedTranscriptTurn,
  TranscriptOccurrenceCodec,
} from "./transcript-occurrence-deriver.js";

interface GeneratedBinaryType<Message> {
  fromBinary(bytes: Uint8Array): Message;
}

interface GeneratedJsonMessage {
  toJson(): unknown;
}

interface GeneratedToolCallValue {
  readonly args?: GeneratedJsonMessage & {
    readonly toolName?: string;
    readonly name?: string;
  };
  readonly result?: GeneratedJsonMessage;
}

interface GeneratedConversationTurnStructure {
  readonly turn:
    | {
        readonly case: "agentConversationTurn";
        readonly value: {
          readonly userMessage: Uint8Array;
          readonly steps: readonly Uint8Array[];
        };
      }
    | { readonly case: "shellConversationTurn"; readonly value: unknown }
    | { readonly case: undefined; readonly value?: undefined };
}

interface GeneratedUserMessage {
  readonly text: string;
  readonly textBlobId?: Uint8Array;
}

interface GeneratedConversationStep {
  readonly message:
    | {
        readonly case: "assistantMessage" | "thinkingMessage";
        readonly value: { readonly text: string };
      }
    | {
        readonly case: "toolCall";
        readonly value: {
          readonly tool:
            | {
                readonly case: string;
                readonly value: GeneratedToolCallValue;
              }
            | { readonly case: undefined; readonly value?: undefined };
        };
      }
    | { readonly case: undefined; readonly value?: undefined };
}

/**
 * Narrow generated-source boundary required by the shipped transcript deriver.
 *
 * The constructors are the emitted @bufbuild/protobuf agent.v1 bindings. Their
 * default fromBinary behavior owns malformed-wire errors and unknown-field
 * handling; the tool args/result instances own exact generated toJson behavior.
 */
export interface GeneratedTranscriptOccurrenceBindings {
  readonly ConversationTurnStructure: GeneratedBinaryType<GeneratedConversationTurnStructure>;
  readonly UserMessage: GeneratedBinaryType<GeneratedUserMessage>;
  readonly ConversationStep: GeneratedBinaryType<GeneratedConversationStep>;
}

function generatedType<Message>(
  value: GeneratedBinaryType<Message> | undefined,
  name: string,
): GeneratedBinaryType<Message> {
  if (typeof value?.fromBinary !== "function") {
    throw new TypeError(`generated ${name}.fromBinary is required`);
  }
  return value;
}

function toolName(
  toolCase: string,
  value: GeneratedToolCallValue,
): string {
  if (toolCase === "mcpToolCall") {
    return value.args?.toolName ?? value.args?.name ?? "mcp";
  }
  return toolCase
    .replace(/ToolCall$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Adapts the exact generated message shapes consumed at
 * host-main.cjs:667421-667490. No protobuf decoder or JSON projection is
 * substituted here: all three fromBinary calls and both toJson calls remain on
 * the mandatory generated-source collaborators.
 */
export function createGeneratedTranscriptOccurrenceCodec(
  bindings: GeneratedTranscriptOccurrenceBindings,
): TranscriptOccurrenceCodec {
  const ConversationTurnStructure = generatedType(
    bindings?.ConversationTurnStructure,
    "ConversationTurnStructure",
  );
  const UserMessage = generatedType(bindings?.UserMessage, "UserMessage");
  const ConversationStep = generatedType(
    bindings?.ConversationStep,
    "ConversationStep",
  );

  return {
    decodeTurn(bytes): DecodedTranscriptTurn {
      const decoded = ConversationTurnStructure.fromBinary(bytes);
      if (decoded.turn.case === "agentConversationTurn") {
        return {
          case: "agent",
          userMessage: decoded.turn.value.userMessage,
          steps: decoded.turn.value.steps,
        };
      }
      if (decoded.turn.case === "shellConversationTurn") {
        return { case: "shell" };
      }
      return { case: undefined };
    },

    decodeUserMessage(bytes) {
      const decoded = UserMessage.fromBinary(bytes);
      return {
        text: decoded.text,
        ...(decoded.textBlobId === undefined
          ? {}
          : { textBlobId: decoded.textBlobId }),
      };
    },

    decodeStep(bytes): DecodedTranscriptStep {
      const decoded = ConversationStep.fromBinary(bytes);
      if (
        decoded.message.case === "assistantMessage"
        || decoded.message.case === "thinkingMessage"
      ) {
        return {
          case: decoded.message.case === "assistantMessage"
            ? "assistant"
            : "thinking",
          text: decoded.message.value.text,
        };
      }
      if (decoded.message.case !== "toolCall") {
        return { case: undefined };
      }
      const tool = decoded.message.value.tool;
      if (tool.case == null) return { case: undefined };
      return {
        case: "tool",
        name: toolName(tool.case, tool.value),
        input: tool.value.args?.toJson() ?? {},
        ...(tool.value.result == null
          ? {}
          : { result: tool.value.result.toJson() }),
      };
    },
  };
}
