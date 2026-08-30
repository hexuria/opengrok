import { stripContextTags } from "../../packages/agent-transcript/context-stripping.js";
import {
  bytesEqual,
  formatToolLine,
  TranscriptJournalCorruptionError,
  type DeferredTranscriptStep,
  type TranscriptCheckpoint,
} from "./transcript-journal-codec.js";
import type {
  TranscriptDeriver,
  TranscriptOccurrence,
} from "./transcript-mirror.js";

export interface TranscriptOccurrenceBlobStore {
  getBlob(context: unknown, id: Uint8Array): Promise<Uint8Array | undefined>;
}

export type DecodedTranscriptTurn =
  | { readonly case: "agent"; readonly userMessage: Uint8Array; readonly steps: readonly Uint8Array[] }
  | { readonly case: "shell" }
  | { readonly case: undefined };

export type DecodedTranscriptStep =
  | { readonly case: "assistant" | "thinking"; readonly text: string }
  | {
      readonly case: "tool";
      readonly name: string;
      readonly input: unknown;
      readonly result?: unknown;
    }
  | { readonly case: undefined };

/**
 * Generated protobuf decoding remains a mandatory production input. The
 * emitted deriver consumes ConversationTurnStructure, UserMessage and
 * ConversationStep and relies on generated `toJson()` for tool payloads.
 */
export interface TranscriptOccurrenceCodec {
  decodeTurn(bytes: Uint8Array): DecodedTranscriptTurn;
  decodeUserMessage(bytes: Uint8Array): {
    readonly text: string;
    readonly textBlobId?: Uint8Array;
  };
  decodeStep(bytes: Uint8Array): DecodedTranscriptStep;
}

async function requiredBlob(
  context: unknown,
  store: TranscriptOccurrenceBlobStore,
  id: Uint8Array,
  label: string,
): Promise<Uint8Array> {
  const blob = await store.getBlob(context, id);
  if (blob == null) {
    throw new TranscriptJournalCorruptionError(
      `missing ${label} blob while deriving transcript checkpoint`,
    );
  }
  return blob;
}

function stripHiddenThinkingTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatTextOccurrence(
  role: "user" | "assistant",
  text: string,
): string | undefined {
  const visible = role === "user"
    ? stripContextTags(text)
    : stripHiddenThinkingTags(text);
  if (!visible.trim()) return undefined;
  return JSON.stringify({
    role,
    message: { content: [{ type: "text", text: visible }] },
  });
}

function sameToolInput(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ArtifactTranscriptOccurrenceDeriver
implements TranscriptDeriver<TranscriptOccurrenceBlobStore> {
  constructor(readonly codec: TranscriptOccurrenceCodec) {}

  private async deriveTurn(
    context: unknown,
    store: TranscriptOccurrenceBlobStore,
    turnIndex: number,
    currentBlobId: Uint8Array,
    previousBlobId: Uint8Array | undefined,
    finalizeTurn = false,
    deferredStep?: DeferredTranscriptStep,
  ): Promise<{
    readonly occurrences: readonly TranscriptOccurrence[];
    readonly deferredStep?: DeferredTranscriptStep;
  }> {
    const current = this.codec.decodeTurn(await requiredBlob(
      context,
      store,
      currentBlobId,
      "conversation-turn",
    ));
    if (current.case === "shell") {
      throw new TranscriptJournalCorruptionError(
        "Sand does not support shell conversation turns",
      );
    }

    const previous = previousBlobId == null
      ? undefined
      : this.codec.decodeTurn(await requiredBlob(
          context,
          store,
          previousBlobId,
          "previous conversation-turn",
        ));
    if (previous != null && previous.case !== current.case) {
      throw new TranscriptJournalCorruptionError(
        "durable conversation turn changed kind",
      );
    }
    if (current.case !== "agent") return { occurrences: [] };
    const previousAgent = previous?.case === "agent" ? previous : undefined;

    if (
      previousAgent != null
      && !bytesEqual(previousAgent.userMessage, current.userMessage)
    ) {
      throw new TranscriptJournalCorruptionError(
        "durable agent user message changed after checkpoint",
      );
    }
    if (
      previousAgent != null
      && current.steps.length < previousAgent.steps.length
    ) {
      throw new TranscriptJournalCorruptionError(
        "durable agent steps moved backwards",
      );
    }

    let firstChangedStep = previousAgent?.steps.length ?? 0;
    if (previousAgent != null) {
      for (let index = 0; index < previousAgent.steps.length; index += 1) {
        if (bytesEqual(previousAgent.steps[index]!, current.steps[index]!)) {
          continue;
        }
        if (index + 1 !== previousAgent.steps.length) {
          throw new TranscriptJournalCorruptionError(
            "durable agent step changed before the checkpoint tail",
          );
        }
        firstChangedStep = index;
        break;
      }
    }
    if (deferredStep?.turnIndex === turnIndex) {
      firstChangedStep = Math.min(firstChangedStep, deferredStep.stepIndex);
    }

    const occurrences: TranscriptOccurrence[] = [];
    if (previousAgent == null) {
      const user = this.codec.decodeUserMessage(await requiredBlob(
        context,
        store,
        current.userMessage,
        "user-message",
      ));
      const text = user.text.length > 0
        || user.textBlobId == null
        || user.textBlobId.length === 0
        ? user.text
        : new TextDecoder().decode(await requiredBlob(
            context,
            store,
            user.textBlobId,
            "user-message text",
          ));
      const line = formatTextOccurrence("user", text);
      if (line != null) {
        occurrences.push({ id: `turn:${turnIndex}:user`, line });
      }
    }

    for (
      let stepIndex = firstChangedStep;
      stepIndex < current.steps.length;
      stepIndex += 1
    ) {
      const previousStepBlob = previousAgent?.steps[stepIndex];
      const previousStep = previousStepBlob == null
        ? undefined
        : this.codec.decodeStep(await requiredBlob(
            context,
            store,
            previousStepBlob,
            "previous conversation-step",
          ));
      const step = this.codec.decodeStep(await requiredBlob(
        context,
        store,
        current.steps[stepIndex]!,
        "conversation-step",
      ));
      if (previousStep != null && previousStep.case !== step.case) {
        throw new TranscriptJournalCorruptionError(
          "durable conversation step changed kind",
        );
      }

      if (
        !finalizeTurn
        && stepIndex + 1 === current.steps.length
        && (step.case === "assistant" || step.case === "thinking")
      ) {
        return {
          occurrences,
          deferredStep: { turnIndex, stepIndex },
        };
      }
      if (step.case === "assistant" || step.case === "thinking") {
        const line = formatTextOccurrence("assistant", step.text);
        if (line != null) {
          occurrences.push({
            id: `turn:${turnIndex}:step:${stepIndex}:text`,
            line,
          });
        }
        continue;
      }
      if (step.case !== "tool") continue;
      if (previousStep != null && previousStep.case !== "tool") {
        throw new TranscriptJournalCorruptionError(
          "durable conversation step changed into a tool call",
        );
      }
      if (previousStep?.case === "tool") {
        if (
          previousStep.name !== step.name
          || !sameToolInput(previousStep.input, step.input)
        ) {
          throw new TranscriptJournalCorruptionError(
            "durable tool call changed after checkpoint",
          );
        }
        if (previousStep.result !== undefined) {
          throw new TranscriptJournalCorruptionError(
            "completed durable tool call changed after checkpoint",
          );
        }
        if (step.result !== undefined) {
          occurrences.push({
            id: `turn:${turnIndex}:step:${stepIndex}:tool-result`,
            line: formatToolLine("tool", step.name, step.result),
          });
        }
        continue;
      }
      occurrences.push({
        id: `turn:${turnIndex}:step:${stepIndex}:tool-use`,
        line: formatToolLine("assistant", step.name, step.input),
      });
      if (step.result !== undefined) {
        occurrences.push({
          id: `turn:${turnIndex}:step:${stepIndex}:tool-result`,
          line: formatToolLine("tool", step.name, step.result),
        });
      }
    }
    return { occurrences };
  }

  async initial(
    context: unknown,
    store: TranscriptOccurrenceBlobStore,
    checkpoint: TranscriptCheckpoint,
  ): Promise<readonly TranscriptOccurrence[]> {
    const occurrences: TranscriptOccurrence[] = [];
    for (let turnIndex = 0; turnIndex < checkpoint.turns.length; turnIndex += 1) {
      const turn = await this.deriveTurn(
        context,
        store,
        turnIndex,
        checkpoint.turns[turnIndex]!,
        undefined,
        true,
      );
      occurrences.push(...turn.occurrences);
    }
    return occurrences;
  }

  async derive(
    context: unknown,
    store: TranscriptOccurrenceBlobStore,
    previous: TranscriptCheckpoint,
    checkpoint: TranscriptCheckpoint,
    finalizeCheckpoint: boolean,
    deferred?: DeferredTranscriptStep,
  ): Promise<{
    readonly occurrences: readonly TranscriptOccurrence[];
    readonly deferredStep?: DeferredTranscriptStep;
  }> {
    if (checkpoint.turns.length < previous.turns.length) {
      throw new TranscriptJournalCorruptionError(
        "durable conversation turns moved backwards",
      );
    }
    if (
      previous.turns.length > 1
      && !bytesEqual(
        checkpoint.turns[previous.turns.length - 2]!,
        previous.turns[previous.turns.length - 2]!,
      )
    ) {
      throw new TranscriptJournalCorruptionError(
        "durable conversation history changed before the active turn",
      );
    }

    const derived: Array<{
      readonly turnIndex: number;
      readonly occurrences: readonly TranscriptOccurrence[];
      readonly deferredStep?: DeferredTranscriptStep;
    }> = [];
    if (previous.turns.length > 0) {
      const turnIndex = previous.turns.length - 1;
      if (
        !bytesEqual(previous.turns[turnIndex]!, checkpoint.turns[turnIndex]!)
        || deferred?.turnIndex === turnIndex
      ) {
        derived.push({
          turnIndex,
          ...await this.deriveTurn(
            context,
            store,
            turnIndex,
            checkpoint.turns[turnIndex]!,
            previous.turns[turnIndex]!,
            finalizeCheckpoint || turnIndex + 1 < checkpoint.turns.length,
            deferred,
          ),
        });
      }
    }
    for (
      let turnIndex = previous.turns.length;
      turnIndex < checkpoint.turns.length;
      turnIndex += 1
    ) {
      derived.push({
        turnIndex,
        ...await this.deriveTurn(
          context,
          store,
          turnIndex,
          checkpoint.turns[turnIndex]!,
          undefined,
          finalizeCheckpoint || turnIndex + 1 < checkpoint.turns.length,
          deferred,
        ),
      });
    }
    const nextDeferred = derived.find(
      turn => turn.deferredStep != null,
    )?.deferredStep;
    return {
      occurrences: derived.flatMap(turn => turn.occurrences),
      ...(nextDeferred == null ? {} : { deferredStep: nextDeferred }),
    };
  }
}

export function createTranscriptOccurrenceDeriver(
  codec: TranscriptOccurrenceCodec,
): ArtifactTranscriptOccurrenceDeriver {
  if (
    typeof codec?.decodeTurn !== "function"
    || typeof codec.decodeUserMessage !== "function"
    || typeof codec.decodeStep !== "function"
  ) {
    throw new TypeError("generated transcript occurrence codec is incomplete");
  }
  return new ArtifactTranscriptOccurrenceDeriver(codec);
}
