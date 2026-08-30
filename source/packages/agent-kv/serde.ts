const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface BlobType { kind: string; typeName?: string; mimeType?: string }
export interface Serde<T> { serialize(value: T): Uint8Array; deserialize(blob: Uint8Array): T; getBlobType?(): BlobType }

export class Utf8Serde implements Serde<string> {
  serialize(value: string): Uint8Array { return encoder.encode(value); }
  deserialize(blob: Uint8Array): string { return decoder.decode(blob); }
  getBlobType(): BlobType { return { kind: "string" }; }
}
export const utf8Serde = new Utf8Serde();

export interface BinaryMessage { toBinary(): Uint8Array }
export interface BinaryMessageType<T extends BinaryMessage> { typeName: string; fromBinary(blob: Uint8Array): T }
export class ProtoSerde<T extends BinaryMessage> implements Serde<T> {
  constructor(private readonly proto: BinaryMessageType<T>) {}
  serialize(value: T): Uint8Array { return value.toBinary(); }
  deserialize(blob: Uint8Array): T { return this.proto.fromBinary(blob); }
  getBlobType(): BlobType { return { kind: "proto", typeName: this.proto.typeName }; }
}

export function toHex(value: Uint8Array): string {
  try { return Buffer.from(value).toString("hex"); }
  catch { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
}
export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0) throw new Error("Invalid hex string length");
  const output = new Uint8Array(clean.length / 2);
  for (let index = 0; index < clean.length; index += 2) output[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
  return output;
}
