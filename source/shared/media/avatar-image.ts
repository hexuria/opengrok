export const AVATAR_SOURCE_MAX_BYTES = 25 * 1024 * 1024;

export function avatarSourceSizeError(byteLength: number): string | null {
  return byteLength > AVATAR_SOURCE_MAX_BYTES ? "Choose an image smaller than 25 MB." : null;
}

export const AVATAR_EXTENSION_MIME = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".avif", "image/avif"],
  [".svg", "image/svg+xml"],
]);

export function avatarMimeHintForExtension(extension: string): string {
  return AVATAR_EXTENSION_MIME.get(extension.toLowerCase()) ?? "application/octet-stream";
}
