import { clampGuestName } from "../../groups/xuser.js";

export const MAX_INLINE_IMAGES_PER_ENTRY = 4;

export interface InlineImage { readonly base64: string; readonly mediaType: string; readonly alt?: string }
export interface TurnMessage { readonly speakerKind: "agent" | "human"; readonly speakerName: string; readonly isSelf?: true; readonly text: string }
export type MirrorEntry =
  | { readonly kind: "human-message"; readonly entryId: string; readonly authorAuthId: string; readonly authorName: string; readonly authorAvatarUrl?: string; readonly text: string; readonly images: InlineImage[]; readonly clientNonce?: string; readonly timestampMs: number }
  | { readonly kind: "agent-message"; readonly entryId: string; readonly agentOwnerAuthId: string; readonly agentId: string; readonly authorName: string; readonly text: string; readonly images: InlineImage[]; readonly timestampMs: number };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

export function normalizeInlineImages(raw: unknown): InlineImage[] {
  if (!Array.isArray(raw)) return [];
  const images: InlineImage[] = [];
  for (const value of raw.slice(0, MAX_INLINE_IMAGES_PER_ENTRY)) {
    const image = record(value);
    if (image == null || typeof image.base64 !== "string" || image.base64.length === 0) continue;
    images.push({
      base64: image.base64,
      mediaType: typeof image.mediaType === "string" && image.mediaType.startsWith("image/") ? image.mediaType : "image/png",
      ...(typeof image.alt === "string" && image.alt.length > 0 ? { alt: image.alt } : {}),
    });
  }
  return images;
}

export function normalizeMirrorEntry(value: unknown, nowMs: number): MirrorEntry | null {
  const wire = record(value);
  if (wire == null || typeof wire.entryId !== "string" || wire.entryId.length === 0) return null;
  const text = typeof wire.text === "string" ? wire.text : "";
  const images = normalizeInlineImages(wire.images);
  if (text.length === 0 && images.length === 0) return null;
  const timestampMs = typeof wire.timestampMs === "number" && Number.isFinite(wire.timestampMs) ? wire.timestampMs : nowMs;
  if (wire.kind === "human-message") {
    if (typeof wire.authorAuthId !== "string" || wire.authorAuthId.length === 0) return null;
    return {
      kind: "human-message", entryId: wire.entryId, authorAuthId: wire.authorAuthId,
      authorName: clampGuestName(typeof wire.authorName === "string" ? wire.authorName : ""),
      ...(typeof wire.authorAvatarUrl === "string" && wire.authorAvatarUrl.length > 0 ? { authorAvatarUrl: wire.authorAvatarUrl } : {}),
      text, images,
      ...(typeof wire.clientNonce === "string" && wire.clientNonce.length > 0 ? { clientNonce: wire.clientNonce } : {}),
      timestampMs,
    };
  }
  if (wire.kind === "agent-message") {
    if (typeof wire.agentOwnerAuthId !== "string" || wire.agentOwnerAuthId.length === 0 || typeof wire.agentId !== "string" || wire.agentId.length === 0) return null;
    return { kind: "agent-message", entryId: wire.entryId, agentOwnerAuthId: wire.agentOwnerAuthId, agentId: wire.agentId, authorName: clampGuestName(typeof wire.authorName === "string" ? wire.authorName : ""), text, images, timestampMs };
  }
  return null;
}

export function normalizeTurnMessages(raw: unknown): TurnMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: TurnMessage[] = [];
  for (const value of raw.slice(0, 24)) {
    const message = record(value);
    if (message == null || typeof message.text !== "string" || message.text.length === 0) continue;
    messages.push({
      speakerKind: message.speakerKind === "agent" ? "agent" : "human",
      speakerName: clampGuestName(typeof message.speakerName === "string" ? message.speakerName : ""),
      ...(message.isSelf === true ? { isSelf: true as const } : {}), text: message.text,
    });
  }
  return messages;
}
