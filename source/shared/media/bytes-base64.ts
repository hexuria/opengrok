/** JSON-safe bytes for contextBridge. Typed arrays do not survive renderer → preload. */
export function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  const chunk = 0x2000;
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    const slice = bytes.subarray(offset, offset + chunk);
    let part = "";
    for (let index = 0; index < slice.byteLength; index += 1) part += String.fromCharCode(slice[index]!);
    binary += part;
  }
  return btoa(binary);
}

export function base64ToUint8(value: string): Uint8Array | null {
  if (value.length === 0) return new Uint8Array();
  try {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
  } catch {
    return null;
  }
}

/** Electron IPC / contextBridge may deliver a Buffer, ArrayBuffer, view, Node Buffer JSON, or a plain {0:n, length} clone. */
export function asAttachmentBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return base64ToUint8(value);
  if (typeof value !== "object" || value == null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "Buffer" && Array.isArray(record.data)) return Uint8Array.from(record.data as number[]);
  if (typeof record.bytesBase64 === "string") return base64ToUint8(record.bytesBase64);
  const length = typeof record.length === "number" ? record.length : typeof record.byteLength === "number" ? record.byteLength : -1;
  if (length >= 0 && (length === 0 || typeof record[0] === "number")) {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = Number(record[index]) & 0xff;
    return out;
  }
  return null;
}

export interface StageAttachmentIpcRequest {
  filename?: unknown;
  bytesBase64?: string;
  sourcePath?: unknown;
}

/**
 * Official 0.18 renderer calls stageAttachmentBytes(filename, bytes).
 * Recovered composer calls stageAttachmentBytes({ filename, bytesBase64, sourcePath }).
 */
export function stageAttachmentIpcRequest(filenameOrRequest: unknown, bytes?: unknown): StageAttachmentIpcRequest {
  if (typeof filenameOrRequest === "object" && filenameOrRequest != null && !Array.isArray(filenameOrRequest)) {
    const record = filenameOrRequest as Record<string, unknown>;
    const encoded = typeof record.bytesBase64 === "string"
      ? record.bytesBase64
      : (() => { const payload = asAttachmentBytes(record.bytes) ?? asAttachmentBytes(bytes); return payload == null ? undefined : uint8ToBase64(payload); })();
    return {
      filename: record.filename,
      ...(encoded == null ? {} : { bytesBase64: encoded }),
      ...(record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath }),
    };
  }
  const payload = asAttachmentBytes(bytes);
  return {
    filename: filenameOrRequest,
    ...(payload == null ? {} : { bytesBase64: uint8ToBase64(payload) }),
  };
}
