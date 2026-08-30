import type { Context as OperationContext } from "../context/core.js";
import { createLogger } from "../context/logger.js";
import { createCounter, createHistogram } from "../metrics/index.js";
import { BlobNotFoundError } from "./blob-not-found-error.js";
import { getBlobId, isBlobDurable, type BlobStore } from "./blob-store.js";
import type { BlobType, Serde } from "./serde.js";
import { toHex } from "./serde.js";
import { getBlobMetadataCallback } from "./typed-blob-store.js";

const logger = createLogger("@anysphere/agent-kv:reference");
const LARGE_LAZY_REFERENCE_BLOB_BYTES = 512 * 1024;
const SLOW_LAZY_REFERENCE_DESERIALIZE_MS = 100;

const lazyReferenceCacheMiss = createCounter("agent_kv.lazy_reference.cache_miss", {
  description: "Number of large or slow LazyReference cache misses that require loading and deserializing a blob",
  labelNames: ["blob_type"],
});
const lazyReferenceDeserializeBytes = createHistogram("agent_kv.lazy_reference.deserialize_bytes", {
  description: "Blob byte size loaded on a large or slow LazyReference deserialize cache miss",
  labelNames: ["blob_type"],
});
const lazyReferenceDeserializeDuration = createHistogram("agent_kv.lazy_reference.deserialize_ms", {
  description: "Time spent deserializing a blob on a large or slow LazyReference cache miss",
  labelNames: ["blob_type"],
});

function getBlobTypeLabel(serde: Serde<unknown>): string {
  const blobType = serde.getBlobType?.();
  if (blobType === undefined) return "unknown";
  switch (blobType.kind) {
    case "proto": return blobType.typeName as string;
    case "json": return "json";
    case "string": return "string";
    case "image": return `image:${blobType.mimeType as string}`;
    case "file": return blobType.mimeType ? `file:${blobType.mimeType}` : "file";
    default: return blobType.kind;
  }
}

export class Writeable<Context = unknown> {}
export interface Writeable<Context = unknown> {
  writeToBlobStore(context: Context): Promise<Uint8Array>;
}

interface LastEagerWrite<T> {
  readonly value: T;
  readonly blobId: Uint8Array;
  readonly blobData: Uint8Array;
}

export class EagerReference<T, Context = unknown> {
  declare readonly serde: Serde<T>;
  declare readonly blobStore: BlobStore<Context>;
  declare lastWrittenValue: LastEagerWrite<T> | undefined;
  declare value: T;

  constructor(serde: Serde<T>, blobStore: BlobStore<Context>, value: T) {
    this.serde = serde;
    this.blobStore = blobStore;
    this.lastWrittenValue = undefined;
    this.value = value;
  }

  get(_context: Context): Promise<T> {
    return Promise.resolve(this.value);
  }

  set(value: T): void {
    this.value = value;
  }

  async writeToBlobStore(context: Context): Promise<Uint8Array> {
    if (this.value instanceof Writeable) return this.value.writeToBlobStore(context);
    if (this.value === this.lastWrittenValue?.value) {
      if (!isBlobDurable(this.blobStore, this.lastWrittenValue.blobId)) {
        await this.blobStore.setBlob(
          context,
          this.lastWrittenValue.blobId,
          this.lastWrittenValue.blobData,
        );
      }
      return this.lastWrittenValue.blobId;
    }
    const serialized = this.serde.serialize(this.value);
    const blobId = await getBlobId(serialized);
    const onBlobMetadata = getBlobMetadataCallback(this.blobStore);
    const blobType = this.serde.getBlobType?.();
    if (onBlobMetadata && blobType) onBlobMetadata({ blobId, blobType });
    await this.blobStore.setBlob(context, blobId, serialized);
    this.lastWrittenValue = { value: this.value, blobId, blobData: serialized };
    return blobId;
  }
}

export class LazyReference<T, Context extends OperationContext = OperationContext> {
  declare readonly serde: Serde<T>;
  declare readonly blobStore: BlobStore<Context>;
  declare blobId: Uint8Array;
  declare valuePromise: Promise<T> | undefined;
  declare lastWrittenValue: T | undefined;
  declare lastWrittenBlobData: Uint8Array | undefined;

  constructor(serde: Serde<T>, blobStore: BlobStore<Context>, blobId: Uint8Array) {
    this.serde = serde;
    this.blobStore = blobStore;
    this.blobId = blobId;
    this.valuePromise = undefined;
    this.lastWrittenValue = undefined;
    this.lastWrittenBlobData = undefined;
  }

  async get(context: Context): Promise<T> {
    if (this.valuePromise === undefined) {
      const blobType = getBlobTypeLabel(this.serde as Serde<unknown>);
      this.valuePromise = this.blobStore.getBlob(context, this.blobId).then(blob => {
        if (blob === undefined) throw new BlobNotFoundError([toHex(this.blobId)]);
        const deserializeStart = performance.now();
        const value = this.serde.deserialize(blob);
        this.lastWrittenBlobData = blob;
        const deserializeDurationMs = performance.now() - deserializeStart;
        if (
          blob.byteLength >= LARGE_LAZY_REFERENCE_BLOB_BYTES ||
          deserializeDurationMs >= SLOW_LAZY_REFERENCE_DESERIALIZE_MS
        ) {
          lazyReferenceCacheMiss.increment(context, 1, { blob_type: blobType });
          lazyReferenceDeserializeBytes.histogram(context, blob.byteLength, { blob_type: blobType });
          lazyReferenceDeserializeDuration.histogram(context, deserializeDurationMs, { blob_type: blobType });
          logger.warn(context, "Large lazy reference deserialize", {
            blobType,
            blobBytes: blob.byteLength,
            deserializeDurationMs,
          });
        }
        return value;
      });
      this.valuePromise.then(
        value => { this.lastWrittenValue = value; },
        () => {},
      );
    }
    return this.valuePromise;
  }

  set(value: T): void {
    this.valuePromise = Promise.resolve(value);
  }

  async writeToBlobStore(context: Context): Promise<Uint8Array> {
    if (this.valuePromise === undefined) return this.blobId;
    const value = await this.get(context);
    if (value instanceof Writeable) return value.writeToBlobStore(context);
    if (value === this.lastWrittenValue) {
      if (
        this.lastWrittenBlobData !== undefined &&
        !isBlobDurable(this.blobStore, this.blobId)
      ) {
        await this.blobStore.setBlob(context, this.blobId, this.lastWrittenBlobData);
      }
      return this.blobId;
    }
    const serialized = this.serde.serialize(value);
    const blobId = await getBlobId(serialized);
    const onBlobMetadata = getBlobMetadataCallback(this.blobStore);
    const blobType: BlobType | undefined = this.serde.getBlobType?.();
    if (onBlobMetadata && blobType) onBlobMetadata({ blobId, blobType });
    await this.blobStore.setBlob(context, blobId, serialized);
    this.lastWrittenValue = value;
    this.lastWrittenBlobData = serialized;
    this.blobId = blobId;
    return blobId;
  }
}
