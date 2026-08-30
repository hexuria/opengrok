import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { isInvalidArgumentConnectError } from "../../../shared/connect-errors.js";
import { invariant } from "../../../shared/invariant.js";
import { sha256Hex } from "../../sha256.js";
import type { BoxObjectStore, BoxObjectStoreProvider } from "./box-object-store.js";
import { BoxStoreCanonicalWriteConflictError } from "./object-store-port.js";
import { SandBoxStoreSyncError } from "./box-store-sync-error.js";
import {
  fetchAgentStoreObjectFromUrl,
  fetchAgentStoreObjectToFileFromUrl,
} from "./agent-store-sand-files.js";
import { createRequestCoalescer } from "./request-coalescer.js";

export const SAND_BOX_STORE_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const SAND_BOX_STORE_MULTIPART_PART_SIZE_BYTES = 128 * 1024 * 1024;
export const S3_MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;
export const MULTIPART_COMPLETE_MAX_ATTEMPTS = 3;
export const READ_PRESIGN_BATCH_MAX = 500;
export const WRITE_PRESIGN_BATCH_MAX = 64;
const PREFETCHED_READ_FRESHNESS_MARGIN_MS = 30_000;
const MULTIPART_FAILURE_PRECONDITION_FAILED = 1;
const MULTIPART_FAILURE_TRANSIENT = 5;
const MULTIPART_FAILURE_NAMES = [
  "UNSPECIFIED",
  "PRECONDITION_FAILED",
  "UPLOAD_NOT_FOUND",
  "INVALID_PARTS",
  "CHECKSUM_MISMATCH",
  "TRANSIENT",
  "INTERNAL",
  "RESTART_REQUIRED",
] as const;

export interface MultipartPart {
  readonly partNumber: number;
  readonly offsetBytes: number;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface SandBoxStoreWriteFile {
  readonly relPath: string;
  readonly sha256: string;
  readonly sizeBytes: bigint;
  readonly contentAddressed: boolean;
  readonly ifMatchEtag: string;
  readonly expectAbsent: boolean;
  readonly multipartParts?: readonly {
    readonly partNumber: number;
    readonly sizeBytes: bigint;
    readonly sha256: string;
  }[];
}

export interface SandBoxStoreMultipartInstruction {
  readonly context: unknown | null;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly offsetBytes: bigint;
    readonly sizeBytes: bigint;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  }[];
}

export interface SandBoxStoreWriteInstruction {
  readonly relPath: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly multipart?: SandBoxStoreMultipartInstruction;
}

export interface SandBoxStoreServiceClient {
  presignSandBoxStoreReads(args: { readonly relPaths: readonly string[] }): Promise<{
    readonly instructions: readonly {
      readonly relPath: string;
      readonly url: string;
      readonly expiresAtMs: bigint | number;
    }[];
  }>;
  statSandBoxStoreObject(args: { readonly relPath: string }): Promise<{
    readonly exists: boolean;
    readonly etag: string;
  }>;
  presignSandBoxStoreWrites(args: { readonly files: readonly SandBoxStoreWriteFile[] }): Promise<{
    readonly instructions: readonly SandBoxStoreWriteInstruction[];
  }>;
  completeSandBoxStoreMultipartWrites(args: {
    readonly completions: readonly {
      readonly context: unknown;
      readonly parts: readonly { readonly partNumber: number; readonly etag: string }[];
    }[];
  }): Promise<{
    readonly results: readonly {
      readonly outcome: {
        readonly case: "success";
        readonly value?: unknown;
      } | {
        readonly case: "failure";
        readonly value: { readonly code: number };
      } | {
        readonly case: undefined;
        readonly value?: undefined;
      };
    }[];
  }>;
  abortSandBoxStoreMultipartWrites(args: {
    readonly uploads: readonly { readonly context: unknown }[];
  }): Promise<unknown>;
  listSandBoxStoreObjects(args: {
    readonly prefix: string;
    readonly cursor: string;
    readonly maxEntries: number;
  }): Promise<{
    readonly entries: readonly { readonly relPath: string }[];
    readonly truncated: boolean;
    readonly nextCursor: string;
  }>;
}

export interface SandBoxStoreServiceDependencies {
  readonly client?: SandBoxStoreServiceClient;
  readonly getAccessToken?: (...args: unknown[]) => unknown;
  readonly getMachineId?: (...args: unknown[]) => unknown;
  readonly multipartThresholdBytes?: number;
  readonly multipartPartSizeBytes?: number;
}

export function createSandBoxStoreServiceClient(
  deps: SandBoxStoreServiceDependencies,
): SandBoxStoreServiceClient {
  if (deps.client !== undefined) return deps.client;
  throw new SandBoxStoreSyncError(
    "sand-box-store service client construction requires the unrecovered GrokBot Connect transport",
  );
}

export async function planSandBoxStoreMultipartParts(
  srcPath: string,
  sizeBytes: number,
  partSizeBytes = SAND_BOX_STORE_MULTIPART_PART_SIZE_BYTES,
): Promise<{ readonly parts: MultipartPart[]; readonly wholeSha256: string }> {
  if (sizeBytes <= 0 || !Number.isSafeInteger(sizeBytes)) {
    throw new SandBoxStoreSyncError(`multipart plan requires a positive size, got ${sizeBytes}`);
  }
  if (partSizeBytes <= 0 || !Number.isSafeInteger(partSizeBytes)) {
    throw new SandBoxStoreSyncError(
      `multipart plan requires a positive part size, got ${partSizeBytes}`,
    );
  }
  const parts: MultipartPart[] = [];
  const wholeHash = createHash("sha256");
  let partHash = createHash("sha256");
  let partStart = 0;
  let position = 0;
  const finishPart = () => {
    parts.push({
      partNumber: parts.length + 1,
      offsetBytes: partStart,
      sizeBytes: position - partStart,
      sha256: partHash.digest("hex"),
    });
    partHash = createHash("sha256");
    partStart = position;
  };
  for await (const chunk of createReadStream(srcPath)) {
    let buffer = chunk;
    while (buffer.byteLength > 0) {
      const take = Math.min(partStart + partSizeBytes - position, buffer.byteLength);
      const slice = buffer.subarray(0, take);
      partHash.update(slice);
      wholeHash.update(slice);
      position += take;
      buffer = buffer.subarray(take);
      if (position - partStart === partSizeBytes) finishPart();
    }
  }
  if (position !== sizeBytes) {
    throw new SandBoxStoreSyncError(
      `multipart plan read ${position}B but expected ${sizeBytes}B: the file changed under the plan`,
    );
  }
  if (position > partStart) finishPart();
  return { parts, wholeSha256: wholeHash.digest("hex") };
}

async function streamPutFromFile(
  url: string,
  headers: Record<string, string>,
  srcPath: string,
): Promise<number> {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === "http:" ? http : https;
  const body = createReadStream(srcPath);
  try {
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown, status?: number) => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve(status ?? 0);
        else reject(error);
      };
      const request = transport.request(parsedUrl, { method: "PUT", headers }, (response) => {
        response.on("error", (error) => settle(error));
        response.resume();
        response.on("end", () => settle(undefined, response.statusCode ?? 0));
      });
      request.on("error", (error) => settle(error));
      void pipeline(body, request).catch((error) => settle(error));
    });
  } catch (error) {
    body.destroy();
    throw error;
  }
}

async function streamPutRangeFromFile(
  url: string,
  headers: Record<string, string>,
  srcPath: string,
  offsetBytes: number,
  sizeBytes: number,
): Promise<{ readonly status: number; readonly etag: string }> {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === "http:" ? http : https;
  const body = createReadStream(srcPath, {
    start: offsetBytes,
    end: offsetBytes + sizeBytes - 1,
  });
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown, result?: { readonly status: number; readonly etag: string }) => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve(result ?? { status: 0, etag: "" });
        else reject(error);
      };
      const request = transport.request(parsedUrl, { method: "PUT", headers }, (response) => {
        response.on("error", (error) => settle(error));
        const rawEtag = response.headers.etag;
        const etag = typeof rawEtag === "string" ? rawEtag.replaceAll('"', "").trim() : "";
        response.resume();
        response.on("end", () => settle(undefined, { status: response.statusCode ?? 0, etag }));
      });
      request.on("error", (error) => settle(error));
      void pipeline(body, request).catch((error) => settle(error));
    });
  } catch (error) {
    body.destroy();
    throw error;
  }
}

export class SandBoxStoreServiceProvider implements BoxObjectStoreProvider {
  private readonly client: SandBoxStoreServiceClient;
  private readonly multipartThresholdBytes: number;
  private readonly multipartPartSizeBytes: number;
  private storeInstance: SandBoxStoreServiceObjectStore | undefined;

  constructor(deps: SandBoxStoreServiceDependencies) {
    this.client = deps.client ?? createSandBoxStoreServiceClient(deps);
    this.multipartThresholdBytes = deps.multipartThresholdBytes
      ?? SAND_BOX_STORE_MULTIPART_THRESHOLD_BYTES;
    this.multipartPartSizeBytes = deps.multipartPartSizeBytes
      ?? SAND_BOX_STORE_MULTIPART_PART_SIZE_BYTES;
  }

  forStore(_storeId: string): SandBoxStoreServiceObjectStore {
    this.storeInstance ??= new SandBoxStoreServiceObjectStore(
      this.client,
      this.multipartThresholdBytes,
      this.multipartPartSizeBytes,
    );
    return this.storeInstance;
  }
}

export class SandBoxStoreServiceObjectStore implements BoxObjectStore {
  private readonly sessionEtags = new Map<string, string>();
  private readonly prefetchedReads = new Map<string, { readonly url: string; readonly expiresAtMs: number }>();
  private readonly writePresignCoalescer: (file: SandBoxStoreWriteFile) => Promise<SandBoxStoreWriteInstruction>;

  constructor(
    readonly client: SandBoxStoreServiceClient,
    readonly multipartThresholdBytes = SAND_BOX_STORE_MULTIPART_THRESHOLD_BYTES,
    readonly multipartPartSizeBytes = SAND_BOX_STORE_MULTIPART_PART_SIZE_BYTES,
  ) {
    this.writePresignCoalescer = createRequestCoalescer({
      maxBatchSize: WRITE_PRESIGN_BATCH_MAX,
      run: (files) => this.presignWriteBatch(files),
      conflictKey: (file) => file.relPath,
      shouldSplitOnError: isInvalidArgumentConnectError,
    });
  }

  async prefetchReads(keys: readonly string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += READ_PRESIGN_BATCH_MAX) {
      const chunk = keys.slice(index, index + READ_PRESIGN_BATCH_MAX);
      const response = await this.client.presignSandBoxStoreReads({ relPaths: [...chunk] });
      for (const instruction of response.instructions) {
        this.prefetchedReads.set(instruction.relPath, {
          url: instruction.url,
          expiresAtMs: Number(instruction.expiresAtMs),
        });
      }
    }
  }

  private takePrefetchedRead(key: string): { readonly url: string; readonly expiresAtMs: number } | undefined {
    const cached = this.prefetchedReads.get(key);
    if (cached === undefined) return undefined;
    this.prefetchedReads.delete(key);
    return cached.expiresAtMs - Date.now() > PREFETCHED_READ_FRESHNESS_MARGIN_MS
      ? cached
      : undefined;
  }

  private async presignRead(key: string): Promise<string | null> {
    const response = await this.client.presignSandBoxStoreReads({ relPaths: [key] });
    return response.instructions[0]?.url ?? null;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const cached = this.takePrefetchedRead(key);
    if (cached !== undefined) {
      try {
        const viaCache = await fetchAgentStoreObjectFromUrl(cached.url, key);
        if (viaCache !== null) return viaCache;
      } catch {}
    }
    const url = await this.presignRead(key);
    return url === null ? null : fetchAgentStoreObjectFromUrl(url, key);
  }

  async getToFile(
    key: string,
    destPath: string,
    options?: { readonly maxBytes?: number },
  ): Promise<number | null> {
    const cached = this.takePrefetchedRead(key);
    if (cached !== undefined) {
      try {
        const viaCache = await fetchAgentStoreObjectToFileFromUrl(
          cached.url,
          key,
          destPath,
          options?.maxBytes,
        );
        if (viaCache !== null) return viaCache;
      } catch {}
    }
    const url = await this.presignRead(key);
    return url === null
      ? null
      : fetchAgentStoreObjectToFileFromUrl(url, key, destPath, options?.maxBytes);
  }

  async put(
    key: string,
    bytes: Uint8Array,
    options?: { readonly contentAddressed?: boolean },
  ): Promise<void> {
    if (options?.contentAddressed === true) {
      await this.putContentAddressed(key, bytes);
      return;
    }
    await this.putMutable(key, bytes);
  }

  private async putContentAddressed(key: string, bytes: Uint8Array): Promise<void> {
    const instruction = await this.presignWrite({
      relPath: key,
      sha256: sha256Hex(bytes),
      sizeBytes: BigInt(bytes.byteLength),
      contentAddressed: true,
      ifMatchEtag: "",
      expectAbsent: false,
    });
    const putOnce = () => fetch(instruction.url, {
      method: "PUT",
      headers: { ...instruction.headers },
      body: Buffer.from(bytes),
    });
    let response = await putOnce();
    if (response.status === 409) response = await putOnce();
    if (response.status === 412) return;
    if (!response.ok) {
      throw new SandBoxStoreSyncError(`sand-box-store write failed for ${key}: ${response.status}`);
    }
  }

  private async putMutable(key: string, bytes: Uint8Array): Promise<void> {
    const known = this.sessionEtags.get(key);
    let baseEtag: string | null;
    let baselineSource: "session" | "probe" | "absent";
    if (known !== undefined) {
      baseEtag = known;
      baselineSource = "session";
    } else {
      const stat = await this.client.statSandBoxStoreObject({ relPath: key });
      if (stat.exists) {
        if (stat.etag.length === 0) {
          throw new SandBoxStoreSyncError(
            `sand-box-store write for ${key} has no usable baseline: the object exists but stat carried no etag`,
          );
        }
        baseEtag = stat.etag;
        baselineSource = "probe";
      } else {
        baseEtag = null;
        baselineSource = "absent";
      }
    }
    const instruction = await this.presignWrite({
      relPath: key,
      sha256: sha256Hex(bytes),
      sizeBytes: BigInt(bytes.byteLength),
      contentAddressed: false,
      ifMatchEtag: baseEtag ?? "",
      expectAbsent: baseEtag === null,
    });
    const putOnce = () => fetch(instruction.url, {
      method: "PUT",
      headers: { ...instruction.headers },
      body: Buffer.from(bytes),
    });
    let response = await putOnce();
    if (response.status === 409) response = await putOnce();
    if (response.status === 412 || response.status === 409) {
      this.sessionEtags.delete(key);
      throw new BoxStoreCanonicalWriteConflictError({
        key,
        conflictRelPath: null,
        baseEtag,
        baselineSource,
      });
    }
    if (!response.ok) {
      throw new SandBoxStoreSyncError(`sand-box-store write failed for ${key}: ${response.status}`);
    }
    const etag = response.headers.get("etag");
    const normalized = etag === null ? "" : etag.replaceAll('"', "").trim();
    if (normalized.length > 0) this.sessionEtags.set(key, normalized);
    else this.sessionEtags.delete(key);
  }

  async putFromFile(key: string, srcPath: string, sha: string, size: number): Promise<void> {
    const multipartParts = size >= this.multipartThresholdBytes
      ? await this.planMultipartParts(key, srcPath, sha, size)
      : undefined;
    const instruction = await this.writePresignCoalescer({
      relPath: key,
      sha256: sha,
      sizeBytes: BigInt(size),
      contentAddressed: true,
      ifMatchEtag: "",
      expectAbsent: false,
      ...(multipartParts === undefined ? {} : { multipartParts }),
    });
    if (instruction.multipart != null) {
      await this.uploadMultipart(key, srcPath, instruction.multipart);
      return;
    }
    if (size > S3_MAX_SINGLE_PUT_BYTES) {
      throw new SandBoxStoreSyncError(
        `sand-box-store write for ${key} is ${size}B, over the S3 single-PUT maximum, and the backend returned no multipart instruction`,
      );
    }
    const headers = { ...instruction.headers, "content-length": String(size) };
    let status = await streamPutFromFile(instruction.url, headers, srcPath);
    if (status === 409) status = await streamPutFromFile(instruction.url, headers, srcPath);
    if (status === 412) return;
    if (status < 200 || status >= 300) {
      throw new SandBoxStoreSyncError(`sand-box-store write failed for ${key}: ${status}`);
    }
  }

  private async planMultipartParts(
    key: string,
    srcPath: string,
    sha: string,
    size: number,
  ): Promise<readonly { readonly partNumber: number; readonly sizeBytes: bigint; readonly sha256: string }[]> {
    const plan = await planSandBoxStoreMultipartParts(srcPath, size, this.multipartPartSizeBytes);
    if (plan.wholeSha256 !== sha) {
      throw new SandBoxStoreSyncError(
        `sand-box-store multipart plan for ${key} hashed ${plan.wholeSha256} but the caller expected ${sha}`,
      );
    }
    return plan.parts.map((part) => ({
      partNumber: part.partNumber,
      sizeBytes: BigInt(part.sizeBytes),
      sha256: part.sha256,
    }));
  }

  private async uploadMultipart(
    key: string,
    srcPath: string,
    multipart: SandBoxStoreMultipartInstruction,
  ): Promise<void> {
    const context = multipart.context;
    if (context == null) {
      throw new SandBoxStoreSyncError(
        `sand-box-store multipart instruction for ${key} carries no upload context`,
      );
    }
    try {
      const uploaded: { readonly partNumber: number; readonly etag: string }[] = [];
      const parts = [...multipart.parts].sort((left, right) => left.partNumber - right.partNumber);
      for (const part of parts) {
        const headers = { ...part.headers, "content-length": String(part.sizeBytes) };
        const putPart = () => streamPutRangeFromFile(
          part.url,
          headers,
          srcPath,
          Number(part.offsetBytes),
          Number(part.sizeBytes),
        );
        let result = await putPart();
        if (result.status < 200 || result.status >= 300) result = await putPart();
        if (result.status < 200 || result.status >= 300) {
          throw new SandBoxStoreSyncError(
            `sand-box-store multipart part ${part.partNumber} failed for ${key}: ${result.status}`,
          );
        }
        if (result.etag.length === 0) {
          throw new SandBoxStoreSyncError(
            `sand-box-store multipart part ${part.partNumber} for ${key} returned no etag`,
          );
        }
        uploaded.push({ partNumber: part.partNumber, etag: result.etag });
      }
      let lastFailure: string | undefined = "no result";
      for (let attempt = 1; attempt <= MULTIPART_COMPLETE_MAX_ATTEMPTS; attempt += 1) {
        let result: Awaited<ReturnType<SandBoxStoreServiceClient["completeSandBoxStoreMultipartWrites"]>>["results"][number] | undefined;
        try {
          const response = await this.client.completeSandBoxStoreMultipartWrites({
            completions: [{ context, parts: uploaded }],
          });
          result = response.results[0];
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error);
          continue;
        }
        if (result?.outcome.case === "success") return;
        const code = result?.outcome.case === "failure" ? result.outcome.value.code : undefined;
        if (code === MULTIPART_FAILURE_PRECONDITION_FAILED) return;
        lastFailure = code === undefined
          ? "no result"
          : MULTIPART_FAILURE_NAMES[code];
        if (code !== MULTIPART_FAILURE_TRANSIENT) break;
      }
      throw new SandBoxStoreSyncError(
        `sand-box-store multipart complete failed for ${key}: ${lastFailure}`,
      );
    } catch (error) {
      await this.bestEffortAbortMultipart(context);
      throw error;
    }
  }

  private async bestEffortAbortMultipart(context: unknown): Promise<void> {
    try {
      await this.client.abortSandBoxStoreMultipartWrites({ uploads: [{ context }] });
    } catch {}
  }

  private async presignWriteBatch(
    files: SandBoxStoreWriteFile[],
  ): Promise<SandBoxStoreWriteInstruction[]> {
    const response = await this.client.presignSandBoxStoreWrites({
      files: files.map(({ multipartParts, ...file }) => ({
        ...file,
        ...(multipartParts === undefined
          ? {}
          : { multipartParts: multipartParts.map((part) => ({ ...part })) }),
      })),
    });
    return files.map((file, index) => {
      const instruction = response.instructions[index];
      if (instruction?.relPath !== file.relPath) {
        throw new SandBoxStoreSyncError(
          `sand-box-store presign returned ${instruction?.relPath ?? "nothing"} for ${file.relPath}`,
        );
      }
      return instruction;
    });
  }

  private async presignWrite(file: SandBoxStoreWriteFile): Promise<{
    readonly url: string;
    readonly headers: Record<string, string>;
  }> {
    const instruction = await this.writePresignCoalescer(file);
    return { url: instruction.url, headers: { ...instruction.headers } };
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "";
    for (;;) {
      const page = await this.client.listSandBoxStoreObjects({ prefix, cursor, maxEntries: 0 });
      for (const entry of page.entries) keys.push(entry.relPath);
      if (!page.truncated || page.nextCursor.length === 0) return keys;
      cursor = page.nextCursor;
    }
  }

  async delete(key: string): Promise<void> {
    invariant(false, () => `SandBoxStoreServiceObjectStore is append-only; cannot delete ${key}`);
  }
}
