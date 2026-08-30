import { AUDIO_MIME_FROM_EXTENSION, CLIENT_NATIVE_IMAGE_MIME_FROM_EXTENSION, EXTENSION_FROM_IMAGE_MIME, IMAGE_MIME_FROM_EXTENSION, VIDEO_MIME_FROM_EXTENSION, extensionOf } from "./media-extensions.js";
export function imageMimeFromPath(filePath: string): string | undefined { return IMAGE_MIME_FROM_EXTENSION[extensionOf(filePath)]; }
export function servableImageMimeFromPath(filePath: string): string | undefined { const extension = extensionOf(filePath); return IMAGE_MIME_FROM_EXTENSION[extension] ?? CLIENT_NATIVE_IMAGE_MIME_FROM_EXTENSION[extension]; }
export function extensionFromImageMime(mime: string): string | undefined { return EXTENSION_FROM_IMAGE_MIME[mime.toLowerCase()]; }
export function videoMimeFromPath(filePath: string): string | undefined { return VIDEO_MIME_FROM_EXTENSION[extensionOf(filePath)]; }
export function audioMimeFromPath(filePath: string): string | undefined { return AUDIO_MIME_FROM_EXTENSION[extensionOf(filePath)]; }
