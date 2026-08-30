import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  imageMimeFromPath,
  videoMimeFromPath,
} from "../../../shared/media/image-mime.js";
import { filePathFromFileUrl } from "../../../shared/node/paths.js";
import { summarizeWidget } from "../../../shared/sand-widgets.js";
import { loadSelectedImageInputs } from "../../selected-image-inputs.js";
import type { TranscriptEntry } from "./transcript-hub.js";
export interface Reaction {
  emoji: string;
  by: string;
}
export type SendMessage = Record<string, unknown> & {
  type: string;
  reply_to?: string;
};
export function isUserMessageEntry(entry: TranscriptEntry): boolean {
  return entry.kind === "message"
    ? entry.role === "user"
    : entry.kind === "user-attachment";
}
export function toggleReaction(
  reactions: readonly Reaction[] | undefined,
  emoji: string,
  by: string,
): Reaction[] | undefined {
  const current = reactions ?? [],
    has = current.some((r) => r.emoji === emoji && r.by === by),
    next = has
      ? current.filter((r) => !(r.emoji === emoji && r.by === by))
      : [...current, { emoji, by }];
  return next.length > 0 ? next : undefined;
}
export function quotableEntryText(entry: TranscriptEntry): string {
  if (entry.kind === "message")
    return typeof entry.content === "string" ? entry.content : "";
  const message = entry.message as SendMessage | undefined;
  return entry.kind === "send-message" &&
    message?.type === "text" &&
    typeof message.content === "string"
    ? message.content
    : "";
}
export function describeMessageQuote(
  entry: TranscriptEntry,
  maxChars?: number,
): string {
  const text = quotableEntryText(entry).replace(/\s+/g, " ").trim();
  return text.length === 0
    ? entry.id
    : maxChars != null && text.length > maxChars
      ? `${text.slice(0, maxChars)}…`
      : text;
}
export function describeReactedMessageQuote(entry: TranscriptEntry): string {
  return describeMessageQuote(entry, 80);
}
export function describeRepliedMessageQuote(entry: TranscriptEntry): string {
  return describeMessageQuote(entry);
}
export function buildComposedOfflineNote(composedAtMs: number): string {
  return Number.isFinite(composedAtMs)
    ? `[Composed offline at ${new Date(composedAtMs).toISOString()}]`
    : "";
}
export interface UserMessageOptions {
  composedAtMs?: number;
  richText?: string;
  replyTo?: string;
  batchId?: string;
  branched?: boolean;
  clientNonce?: string;
}
export function createUserMessage(
  id: string,
  content: string,
  options: UserMessageOptions = {},
): TranscriptEntry {
  const composedAtMs =
    options.composedAtMs != null && Number.isFinite(options.composedAtMs)
      ? options.composedAtMs
      : undefined;
  return {
    kind: "message",
    id,
    role: "user",
    content,
    richText:
      options.richText != null && options.richText.length > 0
        ? options.richText
        : undefined,
    isStreaming: false,
    timestampMs: composedAtMs ?? Date.now(),
    ...(options.replyTo != null ? { replyTo: options.replyTo } : {}),
    ...(options.batchId != null ? { batchId: options.batchId } : {}),
    ...(options.branched === true ? { branched: true } : {}),
    ...(options.clientNonce != null && options.clientNonce.length > 0
      ? { clientNonce: options.clientNonce }
      : {}),
    ...(composedAtMs == null ? {} : { sentWhileOfflineAtMs: composedAtMs }),
  };
}
export function createSendMessageEntry(
  id: string,
  message: SendMessage,
  timestampMs: number,
): TranscriptEntry {
  return {
    kind: "send-message",
    id,
    message,
    timestampMs,
    ...(message.reply_to != null && message.reply_to.length > 0
      ? { replyTo: message.reply_to }
      : {}),
  };
}
export function stampBoxRequestEntry<T extends object>(
  entry: T,
  handoff: { requestId: string; instruction: string },
): T & { boxRequestId: string; boxInstruction: string } {
  return {
    ...entry,
    boxRequestId: handoff.requestId,
    boxInstruction: handoff.instruction,
  };
}
export async function createUserAttachmentEntry(
  attachments: {
    readImageDimensions(
      path: string,
    ): Promise<{ width?: number; height?: number } | null>;
  },
  id: string,
  filePath: string,
  options: {
    fileName?: string;
    batchId?: string;
    clientNonce?: string;
    byteSize?: number;
    replyTo?: string;
    branched?: boolean;
    timestampMs?: number;
  } = {},
): Promise<TranscriptEntry> {
  const dimensions = await attachments.readImageDimensions(filePath),
    fileName = options.fileName?.trim();
  return {
    kind: "user-attachment",
    id,
    file_path: filePath,
    timestampMs: options.timestampMs ?? Date.now(),
    ...(fileName ? { file_name: fileName } : {}),
    ...(options.batchId != null ? { batchId: options.batchId } : {}),
    ...(options.clientNonce ? { clientNonce: options.clientNonce } : {}),
    width: dimensions?.width,
    height: dimensions?.height,
    byteSize: options.byteSize,
    ...(options.replyTo != null ? { replyTo: options.replyTo } : {}),
    ...(options.branched === true ? { branched: true } : {}),
  };
}
function shapeThreadable(message: SendMessage, replyTo?: string): SendMessage {
  const thread = replyTo == null ? {} : { reply_to: replyTo };
  switch (message.type) {
    case "text":
      return {
        type: "text",
        content: message.content,
        ...(message.images != null ? { images: message.images } : {}),
        ...thread,
      };
    case "widget":
      return { type: "widget", widget: message.widget, ...thread };
    case "cursor-agent":
      return { type: "cursor-agent", bcId: message.bcId, ...thread };
    case "secret-request":
      return {
        type: "secret-request",
        secretRequest: message.secretRequest,
        ...thread,
      };
    case "permission-request":
      return {
        type: "permission-request",
        permission: message.permission,
        ...thread,
      };
    case "connector":
      return {
        type: "connector",
        connector: message.connector,
        variant: message.variant,
        ...thread,
        ...(message.serverId != null ? { serverId: message.serverId } : {}),
        ...(message.reason != null ? { reason: message.reason } : {}),
        ...(message.suggestions != null
          ? { suggestions: message.suggestions }
          : {}),
      };
    case "connectors":
      return {
        type: "connectors",
        connectors: message.connectors,
        ...thread,
        ...(message.reason != null ? { reason: message.reason } : {}),
      };
    case "listener-connect":
      return {
        type: "listener-connect",
        platform: message.platform,
        ...thread,
        ...(message.reason != null ? { reason: message.reason } : {}),
      };
    case "attachment":
      return {
        type: "attachment",
        url: message.url,
        ...thread,
        ...(message.file_name != null ? { file_name: message.file_name } : {}),
        ...(message.alt != null ? { alt: message.alt } : {}),
        ...(message.channel != null ? { channel: message.channel } : {}),
        ...(message.width != null ? { width: message.width } : {}),
        ...(message.height != null ? { height: message.height } : {}),
      };
    default:
      return message;
  }
}
export function stripReplyTo<T extends SendMessage>(message: T): T {
  if (
    [
      "auto-review-approval",
      "local-tool-permission",
      "email-draft",
      "slack-draft",
    ].includes(message.type)
  )
    return message;
  return shapeThreadable(message) as T;
}
export function withReplyTo<T extends SendMessage>(
  message: T,
  replyTo: string,
): T {
  if (
    [
      "auto-review-approval",
      "local-tool-permission",
      "email-draft",
      "slack-draft",
    ].includes(message.type)
  )
    return message;
  return shapeThreadable(message, replyTo) as T;
}
export function skippablePromptSummary(
  message: SendMessage,
): string | undefined {
  if (message.type !== "widget") return undefined;
  return summarizeWidget(
    (message.widget ?? {}) as { prompt?: unknown; options?: unknown },
  );
}
export function splitAttachmentPathsByChannel(paths: readonly string[]): {
  imageAttachmentPaths: string[];
  videoAttachmentPaths: string[];
  fileAttachmentPaths: string[];
} {
  const isImage = (path: string) => imageMimeFromPath(path) !== undefined,
    isVideo = (path: string) => videoMimeFromPath(path) !== undefined;
  return {
    imageAttachmentPaths: paths.filter(isImage),
    videoAttachmentPaths: paths.filter(isVideo),
    fileAttachmentPaths: paths.filter(
      (path) => !isImage(path) && !isVideo(path),
    ),
  };
}
export function buildSelectedVideos(
  paths: readonly string[],
): Array<{ path: string; mimeType: string; filename: string; fps: number }> {
  return paths.map((path) => ({
    path,
    mimeType: videoMimeFromPath(path) ?? "video/mp4",
    filename: basename(path),
    fps: 4,
  }));
}
export function collectInboundImages(
  envelopes: readonly {
    images?: readonly { data: string; mimeType: string }[];
  }[],
): Array<{ data: string; mimeType: string }> {
  return envelopes.flatMap((envelope) => envelope.images ?? []);
}
export async function loadAgentInboundImages(
  images: readonly { url: string }[] | undefined,
): Promise<Awaited<ReturnType<typeof loadSelectedImageInputs>>> {
  const paths = (images ?? [])
    .map((image) => filePathFromFileUrl(image.url))
    .filter((path): path is string => path != null);
  return loadSelectedImageInputs(paths);
}
export async function statAttachedFileSizes(
  paths: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  await Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(path);
        if (info.isFile()) sizes.set(path, info.size);
      } catch {}
    }),
  );
  return sizes;
}
