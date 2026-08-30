import { VIDEO_MIME_FROM_EXTENSION, extensionOf } from "./media-extensions.js";
export const ATTACHMENT_BYTE_LIMIT = 25 * 1024 * 1024; export const VIDEO_BYTE_LIMIT = 200 * 1024 * 1024; export const BYTES_PER_MB = 1024 * 1024;
export function nameLooksLikeVideo(name: string): boolean { return VIDEO_MIME_FROM_EXTENSION[extensionOf(name)] !== undefined; }
export function attachmentByteLimitForName(name: string): number { return nameLooksLikeVideo(name) ? VIDEO_BYTE_LIMIT : ATTACHMENT_BYTE_LIMIT; }
export function formatMegabytes(bytes: number): string { return `${Math.round(bytes / BYTES_PER_MB)} MB`; }
export function formatAttachmentTooLargeNotice(filename: string): string { const video = nameLooksLikeVideo(filename); const limit = video ? VIDEO_BYTE_LIMIT : ATTACHMENT_BYTE_LIMIT; return `"${filename}" is too large to attach (max ${formatMegabytes(limit)}${video ? " for video" : ""}).`; }
export class AttachmentTooLargeError extends Error { constructor(readonly limitBytes: number) { super(`Attachment exceeds ${limitBytes} bytes.`); this.name = "AttachmentTooLargeError"; } }
