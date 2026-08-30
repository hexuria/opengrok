import { toHex } from "./serde.js";
import { createHistogram } from "../metrics/index.js";
import type { Context as OperationContext } from "../context/core.js";

export interface BlobStore<Context = unknown> {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>;
  setBlob(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void>;
  setBlobLocallyOnly(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void>;
  flush(ctx: Context): Promise<void>;
  isBlobDurable?(blobId: Uint8Array): boolean;
}
export function isBlobDurable(blobStore: BlobStore, blobId: Uint8Array): boolean {
  const durable = blobStore.isBlobDurable?.(blobId);
  return durable !== undefined ? durable : true;
}
export function toUint8Array(value: Uint8Array): Uint8Array {
  return typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
export async function getBlobId(blobData: Uint8Array): Promise<Uint8Array> {
  const view = toUint8Array(blobData);
  const owned = new Uint8Array(view.byteLength);
  owned.set(view);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer));
}
const inMemoryGetBlobLatency = createHistogram("agent_kv.in_memory.get_blob.duration_ms", {
  description: "Duration of InMemoryBlobStore getBlob operations in milliseconds",
});
const inMemorySetBlobLatency = createHistogram("agent_kv.in_memory.set_blob.duration_ms", {
  description: "Duration of InMemoryBlobStore setBlob operations in milliseconds",
});
export class InMemoryBlobStore<StoreContext extends OperationContext = OperationContext> implements BlobStore<StoreContext> {
  private readonly blobs = new Map<string, Uint8Array>();
  getBlob(ctx: StoreContext, blobId: Uint8Array): Promise<Uint8Array | undefined> {
    const startTime = performance.now();
    try {
      return Promise.resolve(this.blobs.get(toHex(blobId)));
    } finally {
      inMemoryGetBlobLatency.histogram(ctx, performance.now() - startTime);
    }
  }
  setBlob(ctx: StoreContext, blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    const startTime = performance.now();
    try {
      this.blobs.set(toHex(blobId), blobData);
      return Promise.resolve();
    } finally {
      inMemorySetBlobLatency.histogram(ctx, performance.now() - startTime);
    }
  }
  setBlobLocallyOnly(ctx: StoreContext, blobId: Uint8Array, blobData: Uint8Array): Promise<void> { return this.setBlob(ctx, blobId, blobData); }
  flush(_ctx: StoreContext): Promise<void> { return Promise.resolve(); }
}
