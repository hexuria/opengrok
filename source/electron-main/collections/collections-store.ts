/**
 * Collections: the device-local place multi-selected messages are shared or
 * bookmarked to.
 *
 * Everything here is pure logic over a minimal get/set KV interface (in
 * production, the file-backed client-persistence store). Snapshots are taken at
 * share time and keep only a reference back to the source agent/entry, so a
 * later transcript deletion never empties a collection.
 */

import { randomBytes } from "node:crypto";

import { DEEP_LINK_ID_PATTERN } from "../../shared/deep-link.js";
import { imageMimeFromPath, videoMimeFromPath } from "../../shared/media/image-mime.js";
import { posixPathFromFileUrl } from "../../shared/node/paths.js";
import {
  buildCollectionExportHtml,
  type CollectionRenderMedia,
  type CollectionRenderMessage,
} from "../../shared/collections/collection-render.js";

export const COLLECTIONS_INDEX_KEY = "sand.collections.index.v1";
export const COLLECTIONS_ITEM_KEY_PREFIX = "sand.collections.item.v1.";
export const BOOKMARKS_COLLECTION_ID = "bookmarks";
export const BOOKMARKS_COLLECTION_NAME = "Bookmarks";
export const COLLECTION_MESSAGE_CAP = 500;
export const COLLECTION_NAME_MAX_LENGTH = 120;
export const COLLECTION_JSON_FORMAT = "opengrok-collection";
export const COLLECTION_IMPORT_MAX_BYTES = 256 * 1024 * 1024;
export const COLLECTION_EXPORT_MEDIA_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const COLLECTION_EXPORT_MEDIA_TOTAL_MAX_BYTES = 150 * 1024 * 1024;

const MINTED_COLLECTION_ID_PATTERN = /^col[0-9a-z]{16}$/;

export function collectionItemKey(collectionId: string): string {
  return `${COLLECTIONS_ITEM_KEY_PREFIX}${collectionId}`;
}

export function isCollectionId(value: unknown): value is string {
  return typeof value === "string"
    && (value === BOOKMARKS_COLLECTION_ID || MINTED_COLLECTION_ID_PATTERN.test(value))
    && DEEP_LINK_ID_PATTERN.test(value);
}

export function isReservedCollectionId(value: string): boolean {
  return value === BOOKMARKS_COLLECTION_ID;
}

/** "col" + 16 lowercase base36 characters; always a valid deep-link id. */
export function mintCollectionId(randomValue: () => number = defaultRandomValue): string {
  let id = "col";
  for (let index = 0; index < 16; index += 1) id += (Math.floor(randomValue() * 36)).toString(36);
  return id;
}

function defaultRandomValue(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

export interface CollectionsKvStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface CollectionSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly count: number;
}

export interface CollectionsIndex {
  readonly version: 1;
  readonly collections: readonly CollectionSummary[];
}

export interface CollectionMediaRef {
  readonly srcPath: string;
  readonly mime?: string;
}

export interface CollectionMessage {
  readonly key: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly entryId: string;
  readonly addedAtMs: number;
  readonly entry: Record<string, unknown>;
  readonly media: readonly CollectionMediaRef[];
}

export interface CollectionDocument {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly messages: readonly CollectionMessage[];
}

export interface CollectionMessageInput {
  readonly agentId: string;
  readonly agentName: string;
  readonly entryId: string;
  readonly entry: Record<string, unknown>;
  readonly media?: readonly CollectionMediaRef[];
}

export interface AddMessagesResult {
  readonly collectionId: string;
  readonly name: string;
  readonly added: number;
  readonly duplicates: number;
  readonly dropped: number;
}

export class CollectionsError extends Error {
  constructor(message: string) { super(message); this.name = "CollectionsError"; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function collectionMessageKey(agentId: string, entryId: string): string {
  return `${agentId}/${entryId}`;
}

export function normalizeCollectionName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return name.length === 0 ? fallback : name.slice(0, COLLECTION_NAME_MAX_LENGTH);
}

/** "Collection <date>" is the v1 default when the share flow did not prompt. */
export function defaultCollectionName(nowMs: number): string {
  const date = new Date(nowMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `Collection ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function mediaRefFor(rawPath: unknown): CollectionMediaRef | null {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) return null;
  const trimmed = rawPath.trim();
  if (/^data:/i.test(trimmed) || /^https?:/i.test(trimmed)) return null;
  const srcPath = posixPathFromFileUrl(trimmed) ?? trimmed;
  const mime = imageMimeFromPath(srcPath) ?? videoMimeFromPath(srcPath);
  return mime == null ? { srcPath } : { srcPath, mime };
}

function pushMedia(found: Map<string, CollectionMediaRef>, rawPath: unknown): void {
  const media = mediaRefFor(rawPath);
  if (media != null && !found.has(media.srcPath)) found.set(media.srcPath, media);
}

/** Every media-bearing shape a transcript entry can carry, in one pass. */
export function collectEntryMedia(entry: Readonly<Record<string, unknown>>): CollectionMediaRef[] {
  const found = new Map<string, CollectionMediaRef>();
  if (entry.kind === "user-attachment") pushMedia(found, entry.file_path);
  const message = isRecord(entry.message) ? entry.message : null;
  for (const container of [entry, message]) {
    if (container == null) continue;
    const images = container.images;
    if (Array.isArray(images)) for (const image of images) {
      if (typeof image === "string") pushMedia(found, image);
      else if (isRecord(image)) pushMedia(found, image.url ?? image.path ?? image.file_path);
    }
    const attachments = container.attachments;
    if (Array.isArray(attachments)) for (const attachment of attachments) {
      if (typeof attachment === "string") pushMedia(found, attachment);
      else if (isRecord(attachment)) pushMedia(found, attachment.path ?? attachment.file_path ?? attachment.url);
    }
  }
  return [...found.values()];
}

function parseMediaRefs(value: unknown): CollectionMediaRef[] {
  if (!Array.isArray(value)) return [];
  const media: CollectionMediaRef[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.srcPath !== "string" || raw.srcPath.length === 0) continue;
    media.push(typeof raw.mime === "string" && raw.mime.length > 0 ? { srcPath: raw.srcPath, mime: raw.mime } : { srcPath: raw.srcPath });
  }
  return media;
}

function parseMessage(value: unknown): CollectionMessage | null {
  if (!isRecord(value)) return null;
  const agentId = typeof value.agentId === "string" ? value.agentId : "";
  const entryId = typeof value.entryId === "string" ? value.entryId : "";
  if (agentId.length === 0 || entryId.length === 0 || !isRecord(value.entry)) return null;
  return {
    key: typeof value.key === "string" && value.key.length > 0 ? value.key : collectionMessageKey(agentId, entryId),
    agentId,
    agentName: typeof value.agentName === "string" && value.agentName.length > 0 ? value.agentName : agentId.slice(0, 8),
    entryId,
    addedAtMs: finiteNumber(value.addedAtMs, 0),
    entry: value.entry,
    media: parseMediaRefs(value.media),
  };
}

function parseDocument(value: unknown, fallbackId: string): CollectionDocument | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : fallbackId;
  const messages: CollectionMessage[] = [];
  if (Array.isArray(value.messages)) for (const raw of value.messages) {
    const message = parseMessage(raw);
    if (message != null) messages.push(message);
  }
  return {
    version: 1,
    id,
    name: normalizeCollectionName(value.name, id === BOOKMARKS_COLLECTION_ID ? BOOKMARKS_COLLECTION_NAME : id),
    createdAtMs: finiteNumber(value.createdAtMs, 0),
    updatedAtMs: finiteNumber(value.updatedAtMs, 0),
    messages,
  };
}

function emptyBookmarks(nowMs: number): CollectionDocument {
  return { version: 1, id: BOOKMARKS_COLLECTION_ID, name: BOOKMARKS_COLLECTION_NAME, createdAtMs: nowMs, updatedAtMs: nowMs, messages: [] };
}

function summaryOf(document: CollectionDocument): CollectionSummary {
  return { id: document.id, name: document.name, createdAtMs: document.createdAtMs, updatedAtMs: document.updatedAtMs, count: document.messages.length };
}

/** Bookmarks is always first; everything else is most-recently-touched first. */
export function sortCollectionSummaries(collections: readonly CollectionSummary[]): CollectionSummary[] {
  return [...collections].sort((left, right) => {
    if (left.id === BOOKMARKS_COLLECTION_ID) return right.id === BOOKMARKS_COLLECTION_ID ? 0 : -1;
    if (right.id === BOOKMARKS_COLLECTION_ID) return 1;
    return right.updatedAtMs - left.updatedAtMs || left.name.localeCompare(right.name);
  });
}

export interface CollectionsStoreOptions {
  readonly now?: () => number;
  readonly mintId?: () => string;
}

export class SandCollectionsStore {
  readonly #kv: CollectionsKvStore;
  readonly #now: () => number;
  readonly #mintId: () => string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(kv: CollectionsKvStore, options: CollectionsStoreOptions = {}) {
    this.#kv = kv;
    this.#now = options.now ?? Date.now;
    this.#mintId = options.mintId ?? (() => mintCollectionId());
  }

  /** Serializes every mutation so a burst of shares cannot interleave index writes. */
  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation, operation);
    this.#chain = result.then(() => undefined, () => undefined);
    return result;
  }

  async #readIndex(): Promise<CollectionSummary[]> {
    const raw = await this.#kv.read(COLLECTIONS_INDEX_KEY);
    if (raw == null) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (!isRecord(parsed) || !Array.isArray(parsed.collections)) return [];
    const collections: CollectionSummary[] = [];
    for (const entry of parsed.collections) {
      if (!isRecord(entry) || !isCollectionId(entry.id)) continue;
      collections.push({
        id: entry.id,
        name: normalizeCollectionName(entry.name, entry.id),
        createdAtMs: finiteNumber(entry.createdAtMs, 0),
        updatedAtMs: finiteNumber(entry.updatedAtMs, 0),
        count: Math.max(0, Math.trunc(finiteNumber(entry.count, 0))),
      });
    }
    return collections;
  }

  async #writeIndex(collections: readonly CollectionSummary[]): Promise<void> {
    const index: CollectionsIndex = { version: 1, collections: sortCollectionSummaries(collections) };
    await this.#kv.write(COLLECTIONS_INDEX_KEY, JSON.stringify(index));
  }

  async #readDocument(collectionId: string): Promise<CollectionDocument | null> {
    const raw = await this.#kv.read(collectionItemKey(collectionId));
    if (raw == null) return collectionId === BOOKMARKS_COLLECTION_ID ? emptyBookmarks(this.#now()) : null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return collectionId === BOOKMARKS_COLLECTION_ID ? emptyBookmarks(this.#now()) : null; }
    return parseDocument(parsed, collectionId) ?? (collectionId === BOOKMARKS_COLLECTION_ID ? emptyBookmarks(this.#now()) : null);
  }

  async #persist(document: CollectionDocument): Promise<void> {
    await this.#kv.write(collectionItemKey(document.id), JSON.stringify(document));
    const collections = await this.#readIndex();
    const next = collections.filter((entry) => entry.id !== document.id);
    next.push(summaryOf(document));
    await this.#writeIndex(next);
  }

  /** Bookmarks is synthesized when absent so the sidebar can always pin it first. */
  listCollections(): Promise<CollectionSummary[]> {
    return this.#run(async () => {
      const collections = await this.#readIndex();
      const withBookmarks = collections.some((entry) => entry.id === BOOKMARKS_COLLECTION_ID)
        ? collections
        : [...collections, { id: BOOKMARKS_COLLECTION_ID, name: BOOKMARKS_COLLECTION_NAME, createdAtMs: 0, updatedAtMs: 0, count: 0 }];
      return sortCollectionSummaries(withBookmarks);
    });
  }

  getCollection(collectionId: string): Promise<CollectionDocument | null> {
    return this.#run(async () => {
      if (!isCollectionId(collectionId)) return null;
      return this.#readDocument(collectionId);
    });
  }

  addMessages(request: {
    readonly collectionId?: string | null;
    readonly name?: string | null;
    readonly messages: readonly CollectionMessageInput[];
  }): Promise<AddMessagesResult> {
    return this.#run(async () => {
      const nowMs = this.#now();
      const requestedId = request.collectionId ?? null;
      if (requestedId != null && !isCollectionId(requestedId)) throw new CollectionsError("Unknown collection.");
      let document = requestedId == null ? null : await this.#readDocument(requestedId);
      if (document == null) {
        const id = requestedId ?? this.#mintId();
        if (!isCollectionId(id)) throw new CollectionsError("Minted collection id is invalid.");
        document = {
          version: 1,
          id,
          name: id === BOOKMARKS_COLLECTION_ID ? BOOKMARKS_COLLECTION_NAME : normalizeCollectionName(request.name, defaultCollectionName(nowMs)),
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          messages: [],
        };
      }
      const seen = new Set(document.messages.map((message) => message.key));
      const messages = [...document.messages];
      let added = 0;
      let duplicates = 0;
      let dropped = 0;
      for (const input of request.messages) {
        const key = collectionMessageKey(input.agentId, input.entryId);
        if (seen.has(key)) { duplicates += 1; continue; }
        if (messages.length >= COLLECTION_MESSAGE_CAP) { dropped += 1; continue; }
        seen.add(key);
        messages.push({
          key,
          agentId: input.agentId,
          agentName: input.agentName,
          entryId: input.entryId,
          addedAtMs: nowMs,
          entry: input.entry,
          media: input.media ?? collectEntryMedia(input.entry),
        });
        added += 1;
      }
      const next: CollectionDocument = { ...document, updatedAtMs: added > 0 ? nowMs : document.updatedAtMs, messages };
      await this.#persist(next);
      return { collectionId: next.id, name: next.name, added, duplicates, dropped };
    });
  }

  /**
   * Copies already-snapshotted messages into Bookmarks - no transcript refetch,
   * so promotion works even after the originals were deleted.
   */
  async promoteToBookmarks(collectionId: string, keys: readonly string[]): Promise<AddMessagesResult> {
    const document = await this.getCollection(collectionId);
    if (document == null) throw new CollectionsError("Unknown collection.");
    const wanted = new Set(keys);
    const messages: CollectionMessageInput[] = document.messages
      .filter((message) => wanted.has(message.key))
      .map((message) => ({
        agentId: message.agentId,
        agentName: message.agentName,
        entryId: message.entryId,
        entry: message.entry,
        media: message.media,
      }));
    if (messages.length === 0) throw new CollectionsError("Those messages are not in this collection.");
    return this.addMessages({ collectionId: BOOKMARKS_COLLECTION_ID, messages });
  }

  renameCollection(collectionId: string, name: string): Promise<CollectionSummary> {
    return this.#run(async () => {
      if (!isCollectionId(collectionId)) throw new CollectionsError("Unknown collection.");
      if (isReservedCollectionId(collectionId)) throw new CollectionsError("Bookmarks cannot be renamed.");
      const document = await this.#readDocument(collectionId);
      if (document == null) throw new CollectionsError("Unknown collection.");
      const next: CollectionDocument = { ...document, name: normalizeCollectionName(name, document.name), updatedAtMs: this.#now() };
      await this.#persist(next);
      return summaryOf(next);
    });
  }

  deleteCollection(collectionId: string): Promise<void> {
    return this.#run(async () => {
      if (!isCollectionId(collectionId)) throw new CollectionsError("Unknown collection.");
      if (isReservedCollectionId(collectionId)) throw new CollectionsError("Bookmarks cannot be deleted.");
      await this.#kv.remove(collectionItemKey(collectionId));
      await this.#writeIndex((await this.#readIndex()).filter((entry) => entry.id !== collectionId));
    });
  }

  removeMessages(collectionId: string, keys: readonly string[]): Promise<CollectionDocument> {
    return this.#run(async () => {
      if (!isCollectionId(collectionId)) throw new CollectionsError("Unknown collection.");
      const document = await this.#readDocument(collectionId);
      if (document == null) throw new CollectionsError("Unknown collection.");
      const removing = new Set(keys);
      const messages = document.messages.filter((message) => !removing.has(message.key));
      const next: CollectionDocument = {
        ...document,
        messages,
        updatedAtMs: messages.length === document.messages.length ? document.updatedAtMs : this.#now(),
      };
      await this.#persist(next);
      return next;
    });
  }

  /**
   * Writes an imported document under a fresh id when the incoming id collides.
   * The final id is settled before `materialize` runs, so imported media can be
   * written under the directory the stored references will point at.
   */
  importDocument(request: {
    readonly name: string;
    readonly createdAtMs: number;
    readonly preferredId: string;
    readonly materialize: (collectionId: string) => Promise<readonly CollectionMessage[]>;
  }): Promise<CollectionSummary> {
    return this.#run(async () => {
      const nowMs = this.#now();
      const collections = await this.#readIndex();
      const taken = new Set(collections.map((entry) => entry.id));
      const collides = taken.has(request.preferredId)
        || isReservedCollectionId(request.preferredId)
        || (await this.#kv.read(collectionItemKey(request.preferredId))) != null;
      let id = request.preferredId;
      if (collides) {
        do { id = this.#mintId(); } while (taken.has(id));
      }
      const document: CollectionDocument = {
        version: 1,
        id,
        name: normalizeCollectionName(collides ? `${request.name} (imported)` : request.name, defaultCollectionName(nowMs)),
        createdAtMs: finiteNumber(request.createdAtMs, nowMs),
        updatedAtMs: nowMs,
        messages: (await request.materialize(id)).slice(0, COLLECTION_MESSAGE_CAP),
      };
      await this.#persist(document);
      return summaryOf(document);
    });
  }
}

/* ---------------------------------------------------------------- exports */

export interface CollectionMediaBytes {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/** `maxBytes` lets a reader refuse an oversized file before it loads the body. */
export type CollectionMediaReader = (srcPath: string, maxBytes?: number) => Promise<CollectionMediaBytes | null>;

export interface CollectionJsonExportMedia {
  readonly relPath: string;
  readonly mime: string;
  readonly bytesBase64: string;
}

export interface CollectionJsonExport {
  readonly format: typeof COLLECTION_JSON_FORMAT;
  readonly version: 1;
  readonly exportedAtMs: number;
  readonly collection: { readonly id: string; readonly name: string; readonly createdAtMs: number };
  readonly messages: readonly {
    readonly agentId: string;
    readonly agentName: string;
    readonly entryId: string;
    readonly addedAtMs: number;
    readonly entry: Record<string, unknown>;
    readonly media: readonly CollectionJsonExportMedia[];
  }[];
}

const UNSAFE_REL_PATH = /[^A-Za-z0-9._-]/g;

export function collectionMediaRelPath(index: number, srcPath: string): string {
  const leaf = srcPath.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0).at(-1) ?? "media";
  const safe = leaf.replace(UNSAFE_REL_PATH, "_").replace(/^\.+/, "").slice(-96);
  return `${index}-${safe.length > 0 ? safe : "media"}`;
}

export async function buildCollectionJsonExport(
  document: CollectionDocument,
  readMedia: CollectionMediaReader,
  nowMs: number,
): Promise<CollectionJsonExport> {
  const messages: CollectionJsonExport["messages"] = await Promise.all(document.messages.map(async (message, messageIndex) => {
    const media: CollectionJsonExportMedia[] = [];
    for (const [mediaIndex, reference] of message.media.entries()) {
      const loaded = await readMedia(reference.srcPath).catch(() => null);
      if (loaded == null) continue;
      media.push({
        relPath: collectionMediaRelPath(messageIndex * 100 + mediaIndex, reference.srcPath),
        mime: loaded.mime,
        bytesBase64: Buffer.from(loaded.bytes).toString("base64"),
      });
    }
    return {
      agentId: message.agentId,
      agentName: message.agentName,
      entryId: message.entryId,
      addedAtMs: message.addedAtMs,
      entry: message.entry,
      media,
    };
  }));
  return {
    format: COLLECTION_JSON_FORMAT,
    version: 1,
    exportedAtMs: nowMs,
    collection: { id: document.id, name: document.name, createdAtMs: document.createdAtMs },
    messages,
  };
}

export interface CollectionHtmlExportResult {
  readonly html: string;
  readonly embedded: number;
  readonly skipped: number;
}

/**
 * Media is inlined as data: URIs so the file stands alone. Anything over the
 * per-file cap, or arriving after the total cap is reached, degrades to a
 * named placeholder chip instead of bloating the export.
 */
export async function buildCollectionHtmlExport(input: {
  readonly document: CollectionDocument;
  readonly readMedia: CollectionMediaReader;
  readonly permalink: string;
  readonly exportedAt: string;
  readonly formatTimestamp: (timestampMs: number | undefined) => string;
  readonly fileMaxBytes?: number;
  readonly totalMaxBytes?: number;
}): Promise<CollectionHtmlExportResult> {
  const fileMax = input.fileMaxBytes ?? COLLECTION_EXPORT_MEDIA_FILE_MAX_BYTES;
  const totalMax = input.totalMaxBytes ?? COLLECTION_EXPORT_MEDIA_TOTAL_MAX_BYTES;
  const inlined = new Map<string, string>();
  let total = 0;
  let embedded = 0;
  let skipped = 0;
  for (const message of input.document.messages) {
    for (const reference of message.media) {
      if (inlined.has(reference.srcPath)) continue;
      if (total >= totalMax) { skipped += 1; continue; }
      const loaded = await input.readMedia(reference.srcPath, fileMax).catch(() => null);
      if (loaded == null) { skipped += 1; continue; }
      if (loaded.bytes.byteLength > fileMax || total + loaded.bytes.byteLength > totalMax) { skipped += 1; continue; }
      total += loaded.bytes.byteLength;
      embedded += 1;
      inlined.set(reference.srcPath, `data:${loaded.mime};base64,${Buffer.from(loaded.bytes).toString("base64")}`);
    }
  }
  const messages: CollectionRenderMessage[] = input.document.messages.map((message) => ({
    key: message.key,
    agentId: message.agentId,
    agentName: message.agentName,
    entryId: message.entryId,
    addedAtMs: message.addedAtMs,
    entry: message.entry,
    media: message.media as readonly CollectionRenderMedia[],
  }));
  return {
    html: buildCollectionExportHtml({
      name: input.document.name,
      messages,
      exportedAt: input.exportedAt,
      permalink: input.permalink,
      mediaSrc: (media) => inlined.get(media.srcPath) ?? null,
      formatTimestamp: input.formatTimestamp,
    }),
    embedded,
    skipped,
  };
}

/* ---------------------------------------------------------------- imports */

export interface ParsedCollectionImportMedia {
  readonly relPath: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export interface ParsedCollectionImportMessage {
  readonly agentId: string;
  readonly agentName: string;
  readonly entryId: string;
  readonly addedAtMs: number;
  readonly entry: Record<string, unknown>;
  readonly media: readonly ParsedCollectionImportMedia[];
}

export interface ParsedCollectionImport {
  readonly id: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly messages: readonly ParsedCollectionImportMessage[];
}

const SAFE_REL_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Import validation is fail-closed: format, version, id shape and total decoded
 * size are all checked before anything is written to disk.
 */
export function parseCollectionImport(raw: string, maxBytes: number = COLLECTION_IMPORT_MAX_BYTES): ParsedCollectionImport {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new CollectionsError("This collection file is too large to import.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CollectionsError("This file is not a collection export."); }
  if (!isRecord(parsed) || parsed.format !== COLLECTION_JSON_FORMAT) throw new CollectionsError("This file is not a collection export.");
  if (parsed.version !== 1) throw new CollectionsError("This collection export uses an unsupported version.");
  const collection = parsed.collection;
  if (!isRecord(collection) || !isCollectionId(collection.id)) throw new CollectionsError("This collection export has an invalid id.");
  const messages: ParsedCollectionImportMessage[] = [];
  let totalBytes = 0;
  const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
  for (const rawMessage of rawMessages) {
    if (!isRecord(rawMessage)) continue;
    const agentId = typeof rawMessage.agentId === "string" ? rawMessage.agentId : "";
    const entryId = typeof rawMessage.entryId === "string" ? rawMessage.entryId : "";
    if (agentId.length === 0 || entryId.length === 0 || !isRecord(rawMessage.entry)) continue;
    const media: ParsedCollectionImportMedia[] = [];
    if (Array.isArray(rawMessage.media)) for (const rawMedia of rawMessage.media) {
      if (!isRecord(rawMedia) || typeof rawMedia.relPath !== "string" || typeof rawMedia.bytesBase64 !== "string") continue;
      if (!SAFE_REL_PATH.test(rawMedia.relPath)) throw new CollectionsError("This collection export contains an unsafe media path.");
      const bytes = Buffer.from(rawMedia.bytesBase64, "base64");
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) throw new CollectionsError("This collection file is too large to import.");
      media.push({
        relPath: rawMedia.relPath,
        mime: typeof rawMedia.mime === "string" && rawMedia.mime.length > 0 ? rawMedia.mime : "application/octet-stream",
        bytes,
      });
    }
    messages.push({
      agentId,
      agentName: typeof rawMessage.agentName === "string" && rawMessage.agentName.length > 0 ? rawMessage.agentName : agentId.slice(0, 8),
      entryId,
      addedAtMs: finiteNumber(rawMessage.addedAtMs, 0),
      entry: rawMessage.entry,
      media,
    });
  }
  return {
    id: collection.id,
    name: normalizeCollectionName(collection.name, collection.id),
    createdAtMs: finiteNumber(collection.createdAtMs, 0),
    messages,
  };
}

/**
 * Rewrites every imported media reference to the file the writer just produced,
 * so sand-media:// serves the imported copy rather than a path that only ever
 * existed on the exporting machine.
 */
export async function materializeImportedMessages(
  parsed: ParsedCollectionImport,
  collectionId: string,
  writeMedia: (collectionId: string, relPath: string, bytes: Uint8Array) => Promise<string>,
  nowMs: number,
): Promise<CollectionMessage[]> {
  const messages: CollectionMessage[] = [];
  for (const message of parsed.messages) {
    const media: CollectionMediaRef[] = [];
    for (const item of message.media) {
      const srcPath = await writeMedia(collectionId, item.relPath, item.bytes);
      media.push({ srcPath, mime: item.mime });
    }
    messages.push({
      key: collectionMessageKey(message.agentId, message.entryId),
      agentId: message.agentId,
      agentName: message.agentName,
      entryId: message.entryId,
      addedAtMs: message.addedAtMs > 0 ? message.addedAtMs : nowMs,
      entry: message.entry,
      media,
    });
  }
  return messages;
}
