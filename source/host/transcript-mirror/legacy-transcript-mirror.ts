import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TranscriptStore } from "../../packages/agent-transcript/index.js";
import { stripContextTags } from "../../packages/agent-transcript/context-stripping.js";
import { getSafeConversationId } from "../../packages/utils/workspace-paths.js";
import { decodeSummaryArchiveMessageIds } from "./conversation-state-binary.js";
import type { TranscriptCheckpoint } from "./transcript-journal-codec.js";

export class UnexpectedIncrementalFullWriteError extends Error {
  override name = "UnexpectedIncrementalFullWriteError";
}

export interface LegacyTranscriptState extends TranscriptCheckpoint {
  readonly rootPromptMessagesJson: readonly Uint8Array[];
  readonly summaryArchives: readonly Uint8Array[];
}

export interface LegacyTranscriptBlobStore {
  getBlob(ctx: unknown, id: Uint8Array): Promise<Uint8Array | undefined>;
}

interface CoreMessage {
  readonly role: string;
  readonly content?: string | readonly CoreMessagePart[];
  readonly providerOptions?: {
    readonly cursor?: { readonly isSummary?: boolean };
  };
}

type CoreMessagePart =
  | { readonly type: "text" | "reasoning"; readonly text: string }
  | { readonly type: "redacted-reasoning" }
  | { readonly type: "image" }
  | { readonly type: "file"; readonly filename?: string }
  | { readonly type: "tool-call"; readonly toolName: string; readonly args?: unknown }
  | { readonly type: "tool-result"; readonly toolName: string }
  | { readonly type: string; readonly [key: string]: unknown };

interface JsonMessage {
  role: string;
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ toolName: string; args: unknown }>;
  toolResult?: { toolName: string };
}

export const OVERSIZE_TRANSCRIPT_BLOB_THRESHOLD_BYTES = 5_000_000;
const SERIALIZED_UINT8_ARRAY_MARKER = '"__type":"Uint8Array"';
const textDecoder = new TextDecoder();

export function countTranscriptMessageLines(jsonl: string): number {
  let count = 0;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = null;
    }
    if (
      typeof value === "object" && value != null && "type" in value &&
      (value.type === "metadata" || value.type === "turn_ended")
    ) {
      continue;
    }
    count += 1;
  }
  return count;
}

function createTranscriptBinaryPlaceholder(byteLength: number): string {
  return `[Binary data omitted from transcript: ${byteLength} bytes]`;
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (
    typeof value === "object" && value != null &&
    "__type" in value && value.__type === "Uint8Array" &&
    "hex" in value && typeof value.hex === "string"
  ) {
    return createTranscriptBinaryPlaceholder(value.hex.length / 2);
  }
  return value;
}

function deserializeCoreMessage(blob: Uint8Array): CoreMessage {
  const json = textDecoder.decode(blob);
  return JSON.parse(
    json,
    json.includes(SERIALIZED_UINT8_ARRAY_MARKER) ? jsonReviver : undefined
  ) as CoreMessage;
}

function isSummaryMessage(message: CoreMessage): boolean {
  return message.providerOptions?.cursor?.isSummary === true;
}

function createOversizeBlobOmittedMessage(blobSizeBytes: number): CoreMessage {
  return {
    role: "assistant",
    content: `[Oversize transcript blob omitted: ${(blobSizeBytes / 1e6).toFixed(1)} MB]`
  };
}

async function hydrateBlobIds(
  ctx: unknown,
  blobStore: LegacyTranscriptBlobStore,
  blobIds: readonly Uint8Array[]
): Promise<CoreMessage[]> {
  const messages: CoreMessage[] = [];
  for (const blobId of blobIds) {
    const blob = await blobStore.getBlob(ctx, blobId);
    if (blob == null) continue;
    if (blob.length > OVERSIZE_TRANSCRIPT_BLOB_THRESHOLD_BYTES) {
      messages.push(createOversizeBlobOmittedMessage(blob.length));
      continue;
    }
    try {
      messages.push(deserializeCoreMessage(blob));
    } catch {
      // The artifact treats an unreadable observational transcript blob as absent.
    }
  }
  return messages;
}

async function hydrateMessages(
  ctx: unknown,
  blobStore: LegacyTranscriptBlobStore,
  state: LegacyTranscriptState
): Promise<CoreMessage[]> {
  const allMessages: CoreMessage[] = [];
  const archives = await Promise.all(state.summaryArchives.map(async archiveId => {
    const archive = await blobStore.getBlob(ctx, archiveId);
    if (archive == null) return [];
    try {
      return await hydrateBlobIds(
        ctx,
        blobStore,
        decodeSummaryArchiveMessageIds(archive)
      );
    } catch {
      return [];
    }
  }));
  for (const messages of archives) allMessages.push(...messages);

  const promptMessages = await hydrateBlobIds(
    ctx,
    blobStore,
    state.rootPromptMessagesJson
  );
  allMessages.push(...promptMessages.filter(
    message => message.role !== "system" && !isSummaryMessage(message)
  ));
  return allMessages;
}

function stripHiddenThinkingTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatMessageToJson(message: CoreMessage, stripTags: boolean): JsonMessage {
  const json: JsonMessage = { role: message.role };
  const content = message.content;
  if (typeof content === "string") {
    const processed = stripTags ? stripContextTags(content) : content;
    const visible = message.role === "assistant"
      ? stripHiddenThinkingTags(processed)
      : processed;
    if (visible.trim()) json.text = visible;
    return json;
  }
  if (!Array.isArray(content)) return json;

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: Array<{ toolName: string; args: unknown }> = [];
  let toolResult: { toolName: string } | undefined;
  for (const part of content) {
    switch (part.type) {
      case "text": {
        const processed = stripTags ? stripContextTags(part.text) : part.text;
        const visible = message.role === "assistant"
          ? stripHiddenThinkingTags(processed)
          : processed;
        if (visible.trim()) textParts.push(visible);
        break;
      }
      case "reasoning":
        if (part.text.trim()) thinkingParts.push(part.text);
        break;
      case "redacted-reasoning":
        thinkingParts.push("[REDACTED]");
        break;
      case "image":
        textParts.push("[Image]");
        break;
      case "file":
        textParts.push(part.filename ? `[File: ${part.filename}]` : "[File]");
        break;
      case "tool-call":
        toolCalls.push({ toolName: part.toolName, args: part.args });
        break;
      case "tool-result":
        toolResult = { toolName: part.toolName };
        break;
    }
  }
  if (textParts.length > 0) json.text = textParts.join("\n");
  if (thinkingParts.length > 0) json.thinking = thinkingParts.join("\n");
  if (toolCalls.length > 0) json.toolCalls = toolCalls;
  if (toolResult != null) json.toolResult = toolResult;
  return json;
}

export function formatSingleMessageJsonl(message: CoreMessage): string | undefined {
  if (message.role === "system" || isSummaryMessage(message)) return undefined;
  const json = formatMessageToJson(message, message.role === "user");
  const content: Array<Record<string, unknown>> = [];
  const textParts: string[] = [];
  if (json.text != null) textParts.push(json.text);
  if (json.thinking != null) textParts.push(json.thinking);
  if (textParts.length > 0) {
    content.push({ type: "text", text: textParts.join("\n\n") });
  }
  for (const call of json.toolCalls ?? []) {
    content.push({ type: "tool_use", name: call.toolName, input: call.args });
  }
  if (content.length === 0) return undefined;
  return JSON.stringify({ role: message.role, message: { content } });
}

function formatTranscriptJsonl(messages: readonly CoreMessage[]): string {
  let filtered = messages.filter(message => message.role !== "system");
  if (
    filtered.length >= 2 &&
    filtered[0]?.role === "user" && filtered[1]?.role === "user"
  ) {
    filtered = filtered.slice(1);
  }
  return filtered.flatMap(message => {
    const line = formatSingleMessageJsonl(message);
    return line == null ? [] : [line];
  }).join("\n");
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export class LegacyFileTranscriptMirror {
  constructor(readonly transcriptsDir: string) {}

  jsonlPathFor(conversationId: string): string {
    const safeId = getSafeConversationId(conversationId);
    return join(this.transcriptsDir, safeId, `${safeId}.jsonl`);
  }

  async writeIncremental(
    ctx: unknown,
    conversationId: string,
    state: LegacyTranscriptState,
    blobStore: LegacyTranscriptBlobStore,
    previousRootPromptCount: number
  ): Promise<number | null> {
    const currentCount = state.rootPromptMessagesJson.length;
    if (previousRootPromptCount === 0 || currentCount < previousRootPromptCount) {
      return null;
    }
    const store = this.transcriptStore(blobStore, async () => {
      throw new UnexpectedIncrementalFullWriteError(
        "incremental transcript mirror attempted a full write",
      );
    });
    const writtenCount = await store.writeFromStateIncremental(
      ctx as Parameters<TranscriptStore["writeFromStateIncremental"]>[0],
      state,
      conversationId,
      previousRootPromptCount,
    );
    return writtenCount === 0 ? null : writtenCount;
  }

  async writeFull(
    ctx: unknown,
    conversationId: string,
    state: LegacyTranscriptState,
    blobStore: LegacyTranscriptBlobStore
  ): Promise<boolean> {
    let wroteFile = false;
    const store = this.transcriptStore(blobStore, async (filePath, content) => {
      await mkdir(dirname(filePath), { recursive: true });
      if (filePath === this.jsonlPathFor(conversationId)) {
        let existing: string | null;
        try {
          existing = await readFile(filePath, "utf8");
        } catch {
          existing = null;
        }
        if (
          existing != null &&
          countTranscriptMessageLines(content) < countTranscriptMessageLines(existing)
        ) {
          return;
        }
      }
      await writeFile(filePath, content, "utf8");
      wroteFile = true;
    });
    const completed = await store.writeFromStateFull(
      ctx as Parameters<TranscriptStore["writeFromStateFull"]>[0],
      state,
      conversationId,
    );
    return completed && (wroteFile || (
      state.summaryArchives.length === 0 &&
      state.rootPromptMessagesJson.length === 0
    ));
  }

  private transcriptStore(
    blobStore: LegacyTranscriptBlobStore,
    writeTranscript: (filePath: string, content: string) => Promise<void>,
  ): TranscriptStore {
    return new TranscriptStore(this.transcriptsDir, blobStore, writeTranscript, {
      writeText: false,
      writeJsonl: true,
      appendFile: async (filePath, content) => {
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, content, "utf8");
      },
      fallbackToFullWriteOnIncrementalFailure: false,
      pathResolver: (conversationId, ext) => {
        const safeId = getSafeConversationId(conversationId);
        return join(this.transcriptsDir, safeId, `${safeId}.${ext}`);
      },
    });
  }
}
