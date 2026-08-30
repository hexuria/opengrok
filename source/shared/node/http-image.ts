export function imageContentType(response: Pick<Response, "headers">): string | null {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  return contentType.startsWith("image/") ? contentType : null;
}

export async function readCappedImageBytes(response: Pick<Response, "headers" | "body">, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (response.body == null) return null;
  const chunks: Uint8Array[] = []; let total = 0; const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return total > 0 ? Buffer.concat(chunks) : null;
}

export async function responseToImageDataUrl(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.ok) return null;
  const contentType = imageContentType(response); if (contentType == null) return null;
  const bytes = await readCappedImageBytes(response, maxBytes); if (bytes == null) return null;
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}
