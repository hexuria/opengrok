import type { BlobStore } from "./blob-store.js";

export const BLOB_METADATA_CALLBACK_SYMBOL = Symbol.for("anysphere.blobMetadataCallback");
export interface BlobMetadata { blobId: Uint8Array; blobType: unknown }
export type BlobMetadataCallback = (metadata: BlobMetadata) => void;
type MetadataStore<Context> = BlobStore<Context> & { [BLOB_METADATA_CALLBACK_SYMBOL]?: BlobMetadataCallback };

export function getBlobMetadataCallback<Context>(blobStore: BlobStore<Context>): BlobMetadataCallback | undefined {
  return BLOB_METADATA_CALLBACK_SYMBOL in blobStore ? (blobStore as MetadataStore<Context>)[BLOB_METADATA_CALLBACK_SYMBOL] : undefined;
}
export function unwrapBlobStore<Context>(blobStore: BlobStore<Context>): BlobStore<Context> {
  return blobStore instanceof TypedBlobStore ? unwrapBlobStore(blobStore.getInnerBlobStore()) : blobStore;
}
interface WritethroughBlobStore<Context> extends BlobStore<Context> {
  setBlobAwaitingSecondary(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void>;
}
function isWritethroughBlobStore<Context>(blobStore: BlobStore<Context>): blobStore is WritethroughBlobStore<Context> {
  return typeof (blobStore as Partial<WritethroughBlobStore<Context>>).setBlobAwaitingSecondary === "function";
}
export async function setBlobReadableFromCloudMirror<Context>(options: { blobStore: BlobStore<Context>; ctx: Context; blobId: Uint8Array; blobData: Uint8Array }): Promise<void> {
  const target = unwrapBlobStore(options.blobStore);
  if (isWritethroughBlobStore(target)) {
    await target.setBlobAwaitingSecondary(options.ctx, options.blobId, options.blobData);
    return;
  }
  await options.blobStore.setBlob(options.ctx, options.blobId, options.blobData);
  await options.blobStore.flush(options.ctx);
}

export class TypedBlobStore<Context = unknown> implements BlobStore<Context> {
  readonly [BLOB_METADATA_CALLBACK_SYMBOL]: BlobMetadataCallback | undefined;
  constructor(private readonly inner: BlobStore<Context>, onBlobMetadata?: BlobMetadataCallback) { this[BLOB_METADATA_CALLBACK_SYMBOL] = onBlobMetadata; }
  getInnerBlobStore(): BlobStore<Context> { return this.inner; }
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined> { return this.inner.getBlob(ctx, blobId); }
  setBlob(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void> { return this.inner.setBlob(ctx, blobId, blobData); }
  setBlobLocallyOnly(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void> { return this.inner.setBlobLocallyOnly(ctx, blobId, blobData); }
  flush(ctx: Context): Promise<void> { return this.inner.flush(ctx); }
  isBlobDurable(blobId: Uint8Array): boolean {
    const durable = this.inner.isBlobDurable?.(blobId);
    return durable !== undefined ? durable : true;
  }
}
