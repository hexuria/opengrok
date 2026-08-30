import { Buffer } from "node:buffer";
import { isGroupTurnPromptText } from "../groups/group-chat.js";
import {
  parseShellTerminalFooter,
  SHELL_REWATCH_MAX_WAIT_MS,
  SHELL_REWATCH_MISSING_FILE_GIVE_UP,
  shellRewatchPollMs,
} from "./background-work.js";
import { selectUnconfirmedUserMessages } from "./conversation-state.js";
import { SAND_HIDDEN_PROMPT_MARKER } from "./sand-prompt-markers.js";
import { buildUserMessageAddressNote } from "./system-prompt.js";
import {
  ConversationStateStructure,
  ConversationTurnStructure,
  UserMessage,
} from "../../packages/proto/generated/agent/v1/agent_pb.js";
import { readExecutorResource } from "../../packages/agent-exec/read.js";
import { ReadArgs, type ReadResult } from "../../packages/proto/generated/agent/v1/read_exec_pb.js";
import type { BlobStore } from "../../packages/agent-kv/blob-store.js";
import {
  SandLocalToolPermissionDeniedError,
  sandLocalToolScopeKey,
} from "../../shared/local-tool-permission-machinery.js";
import type { Context } from "../../packages/context/core.js";

export class SandTerminalReadError extends Error {
}

export type TerminalReadResult = ReadResult;

export interface TerminalRemoteAccessor<Context> {
  read(context: Context, args: { readonly path: string; readonly toolCallId: string }): Promise<TerminalReadResult>;
}

export interface ShellWatchResourceAccessor<Context = unknown> {
  get(resource: typeof readExecutorResource): {
    execute(context: Context, args: ReadArgs, options?: unknown): Promise<ReadResult>;
  };
}

export function createShellWatchReadAccessor<Context>(
  accessor: ShellWatchResourceAccessor<Context>,
): TerminalRemoteAccessor<Context> {
  return {
    read: async (context, args) => await accessor.get(readExecutorResource).execute(
      context,
      new ReadArgs({ path: args.path, toolCallId: args.toolCallId }),
    ),
  };
}

export interface TerminalConnection<Context> {
  readonly terminalsFolder: string;
  readonly remoteAccessor: TerminalRemoteAccessor<Context>;
}

export interface RecentTerminalUserMessage {
  readonly id: string;
  readonly text: string;
  readonly richText?: string;
}

export interface MaterializedUserMessage {
  readonly text: string;
  readonly messageId: string;
  readonly richText?: string;
}

export interface ConfirmedUserTurnWatermark {
  readonly turnCount: number;
  readonly boundaryRef: Uint8Array;
  readonly lastUserMessageId?: string;
  readonly hasUserTurn: boolean;
}

export interface ShellTerminalWatchHost<Context> {
  readonly ctx: Context;
  getConversationId(): string;
  ensureBoxReady(context: Context, conversationId: string): Promise<TerminalConnection<Context>>;
  createLocalToolContext?(context: Context, agentId: string): Context;
  terminalFilePath?(folder: string, id: string): string | undefined;
  getConversationState(): { readonly turns: readonly Uint8Array[] };
  getBlob(context: Context, blobId: Uint8Array): Promise<Uint8Array | null>;
  decodeConversationTurn(bytes: Uint8Array): ConversationTurnStructure;
  decodeUserMessage(bytes: Uint8Array): { readonly text: string; readonly messageId: string };
  getConfirmedUserTurnWatermarkCache(): ConfirmedUserTurnWatermark | undefined;
  setConfirmedUserTurnWatermarkCache(cache: ConfirmedUserTurnWatermark): void;
  now?(): number;
  delay?(milliseconds: number): Promise<void>;
}

/**
 * The generated state/blob portion of the immutable shell-watch host.
 *
 * The runner still owns box readiness and the remote read executor. Keeping
 * those concerns out of this projection is deliberate: this leaf only binds
 * the generated conversation state and blob store to the decoders consumed by
 * watermark discovery.
 */
export interface ShellWatchGeneratedStateOwner<Context = unknown> {
  getConversationState(): ConversationStateStructure;
  getBlobStore(): BlobStore<Context>;
}

export function createShellWatchGeneratedStateProjection<Context>(
  owner: ShellWatchGeneratedStateOwner<Context>,
): Pick<
  ShellTerminalWatchHost<Context>,
  "getConversationState" | "getBlob" | "decodeConversationTurn" | "decodeUserMessage"
> {
  return {
    getConversationState: () => owner.getConversationState(),
    getBlob: async (context, blobId) => {
      const blob = await owner.getBlobStore().getBlob(context, blobId);
      return blob ?? null;
    },
    decodeConversationTurn: bytes => ConversationTurnStructure.fromBinary(bytes),
    decodeUserMessage: bytes => {
      const message = UserMessage.fromBinary(bytes);
      return { text: message.text, messageId: message.messageId };
    },
  };
}

export interface TerminalFileSnapshot {
  readonly exists: boolean;
  readonly content: string;
}

export type ShellWatchStatus = "success" | "error";

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function readShellTerminalSnapshot<Context>(
  _host: ShellTerminalWatchHost<Context>,
  accessor: TerminalRemoteAccessor<Context>,
  path: string,
  context: Context,
): Promise<TerminalFileSnapshot> {
  const result = await accessor.read(context, { path, toolCallId: "" });
  switch (result.result.case) {
    case "success": {
      const success = result.result.value as {
        readonly output?: {
          readonly case?: string;
          readonly value?: unknown;
        };
      } | undefined;
      const output = success?.output;
      let content = "";
      if (output?.case === "content" && typeof output.value === "string") {
        content = output.value;
      } else if (output?.case === "data" && output.value instanceof Uint8Array) {
        content = Buffer.from(output.value).toString("utf8");
      }
      return { exists: true, content };
    }
    case "fileNotFound":
      return { exists: false, content: "" };
    default:
      throw new SandTerminalReadError(
        `terminal file read failed (${result.result.case ?? "unknown"})`,
      );
  }
}

export async function pollShellTerminalFile<Context>(
  host: ShellTerminalWatchHost<Context>,
  id: string,
  isCancelled: () => boolean,
  settle: (status: ShellWatchStatus, detail?: string, outputPath?: string) => void,
): Promise<void> {
  const pollMs = shellRewatchPollMs();
  const now = host.now ?? Date.now;
  const delay = host.delay ?? defaultDelay;
  const deadlineMs = now() + SHELL_REWATCH_MAX_WAIT_MS;
  let missingReads = 0;
  let outputPath: string | undefined;
  while (!isCancelled()) {
    try {
      const contextWithScope = host.ctx as unknown as {
        with?: (
          key: typeof sandLocalToolScopeKey,
          value: { readonly agentId: string },
        ) => Context;
      };
      const pollContext = typeof contextWithScope.with === "function"
        ? contextWithScope.with(
          sandLocalToolScopeKey,
          { agentId: host.getConversationId() },
        )
        : host.createLocalToolContext?.(
          host.ctx,
          host.getConversationId(),
        ) ?? host.ctx;
      const connection = await host.ensureBoxReady(pollContext, host.getConversationId());
      const folder = connection.terminalsFolder;
      outputPath = host.terminalFilePath?.(folder, id) ?? `${folder}/${id}.txt`;
      const snapshot = await readShellTerminalSnapshot(
        host,
        connection.remoteAccessor,
        outputPath,
        pollContext,
      );
      if (snapshot.exists) {
        missingReads = 0;
        const footer = parseShellTerminalFooter(snapshot.content);
        if (footer.isComplete) {
          const status = footer.exitCode === 0 ? "success" : "error";
          const detail = footer.exitCode === 0
            ? undefined
            : footer.isStreamFailure === true
              ? "the command's output stream failed; read its output file for the error"
              : `exit_code=${footer.exitCode ?? "unknown"}`;
          settle(status, detail, outputPath);
          return;
        }
      } else {
        missingReads += 1;
        if (missingReads >= SHELL_REWATCH_MISSING_FILE_GIVE_UP) {
          settle(
            "error",
            "The command's terminal output file no longer exists, so its completion can no longer be observed (it may have been cleaned up).",
            outputPath,
          );
          return;
        }
      }
    } catch (error) {
      if (error instanceof SandLocalToolPermissionDeniedError) {
        settle(
          "error",
          "Grok Bot is no longer allowed to read this command's output on the user's computer, so its completion cannot be observed. The command keeps running; ask the user to approve reading its output file for the result.",
          outputPath,
        );
        return;
      }
    }
    if (now() >= deadlineMs) break;
    await delay(pollMs);
  }
  if (isCancelled()) return;
  settle(
    "error",
    `The command is still running after ${Math.round(SHELL_REWATCH_MAX_WAIT_MS / 60_000)} minutes. It keeps running; check its output file for the result.`,
    outputPath,
  );
}

export async function collectPrependUserMessages<Context>(
  host: ShellTerminalWatchHost<Context>,
  recentUserMessages: readonly RecentTerminalUserMessage[] | null | undefined,
  currentMessageId?: string,
): Promise<UserMessage[]> {
  if (recentUserMessages == null || recentUserMessages.length === 0) return [];
  const state = host.getConversationState();
  const { lastUserMessageId, hasUserTurn } = await findConfirmedUserTurnWatermark(host, state);
  const selected = selectUnconfirmedUserMessages({
    recentUserMessages,
    ...(currentMessageId == null ? {} : { currentMessageId }),
    ...(lastUserMessageId == null ? {} : { lastTurnUserMessageId: lastUserMessageId }),
    hasConfirmedTurns: hasUserTurn,
  });
  return selected.map((message) => {
    const addressNote = buildUserMessageAddressNote(message.id);
    const text = addressNote.length > 0 ? `${addressNote}\n${message.text}` : message.text;
    return new UserMessage({
      text,
      messageId: message.id,
      ...(message.richText != null && message.richText.length > 0
        ? { richText: message.richText }
        : {}),
    });
  });
}

export async function findConfirmedUserTurnWatermark<Context>(
  host: ShellTerminalWatchHost<Context>,
  state: { readonly turns: readonly Uint8Array[] },
): Promise<{ readonly lastUserMessageId?: string; readonly hasUserTurn: boolean }> {
  const cached = host.getConfirmedUserTurnWatermarkCache();
  const boundaryRef = cached != null && cached.turnCount > 0 && cached.turnCount <= state.turns.length
    ? state.turns[cached.turnCount - 1]
    : undefined;
  const cacheValid = cached != null && (
    cached.turnCount === 0
    || (boundaryRef != null && turnRefsEqual(boundaryRef, cached.boundaryRef))
  );
  const stopIndex = cacheValid ? cached.turnCount : 0;
  const cacheResult = (
    result: { readonly lastUserMessageId?: string; readonly hasUserTurn: boolean },
  ) => {
    const turnCount = state.turns.length;
    host.setConfirmedUserTurnWatermarkCache({
      turnCount,
      boundaryRef: turnCount > 0 ? state.turns[turnCount - 1] ?? new Uint8Array() : new Uint8Array(),
      ...(result.lastUserMessageId == null
        ? {}
        : { lastUserMessageId: result.lastUserMessageId }),
      hasUserTurn: result.hasUserTurn,
    });
    return result;
  };

  for (let index = state.turns.length - 1; index >= stopIndex; index -= 1) {
    const turnBlobId = state.turns[index];
    if (turnBlobId == null || turnBlobId.length === 0) continue;
    let userMessage: { readonly text: string; readonly messageId: string };
    try {
      const turnBlob = await host.getBlob(host.ctx, turnBlobId);
      if (turnBlob == null) return { hasUserTurn: true };
      const turnStructure = host.decodeConversationTurn(turnBlob);
      if (turnStructure.turn.case !== "agentConversationTurn") continue;
      const agentTurn = turnStructure.turn.value as {
        readonly userMessage?: Uint8Array;
      };
      const userMessageBlobId = agentTurn.userMessage;
      if (userMessageBlobId == null || userMessageBlobId.length === 0) {
        return { hasUserTurn: true };
      }
      const userMessageBlob = await host.getBlob(host.ctx, userMessageBlobId);
      if (userMessageBlob == null) return { hasUserTurn: true };
      userMessage = host.decodeUserMessage(userMessageBlob);
    } catch {
      return { hasUserTurn: true };
    }
    if (userMessage.text.startsWith(SAND_HIDDEN_PROMPT_MARKER)) continue;
    if (userMessage.messageId.length === 0 && isGroupTurnPromptText(userMessage.text)) continue;
    return cacheResult({
      lastUserMessageId: userMessage.messageId,
      hasUserTurn: true,
    });
  }
  if (cached != null && cacheValid && stopIndex > 0) {
    return cacheResult({
      ...(cached.lastUserMessageId == null
        ? {}
        : { lastUserMessageId: cached.lastUserMessageId }),
      hasUserTurn: cached.hasUserTurn,
    });
  }
  return cacheResult({ hasUserTurn: false });
}

export function turnRefsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
