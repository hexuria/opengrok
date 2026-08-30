import { normalizeS3Etag } from "./etag.js";
import { assertPresignedUrlSafe } from "./presigned-url.js";
import { normalizeRelPath } from "./safe-paths.js";

interface PresignedRead {
  readonly relPath: string;
  readonly url: string;
}

interface ObjectProbeResponse {
  readonly status: number;
  readonly headers: { readonly get: (name: string) => string | null | undefined };
  readonly body?: { readonly cancel?: () => Promise<unknown> | unknown } | null;
}

interface ObjectProbeClient {
  presignReads(args: { readonly agentId: string; readonly relPaths: readonly string[]; readonly signal?: AbortSignal | undefined }): Promise<readonly PresignedRead[]>;
}

interface ObjectProbeArgs {
  readonly client: ObjectProbeClient;
  readonly agentId: string;
  readonly relPath: string;
  readonly fetchImpl: (url: string, options: { readonly redirect: "error"; readonly signal?: AbortSignal; readonly headers?: { readonly Range: "bytes=0-0" } }) => Promise<ObjectProbeResponse>;
  readonly validatePresignedUrl: (url: URL) => void;
  readonly signal?: AbortSignal;
  readonly runPresign?: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly runS3?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type AgentStoreObjectProbeResult = { readonly kind: "absent" } | { readonly kind: "exists"; readonly etag: string };

export async function probeAgentStoreObject(args: ObjectProbeArgs): Promise<AgentStoreObjectProbeResult> {
  const runPresign = args.runPresign ?? (async <T>(fn: () => Promise<T>) => fn());
  const runS3 = args.runS3 ?? (async <T>(fn: () => Promise<T>) => fn());
  const [presigned] = await runPresign(() => args.client.presignReads({
    agentId: args.agentId,
    relPaths: [args.relPath],
    signal: args.signal,
  }));
  if (presigned === undefined) {
    throw new Error(`agent-store baseline probe returned no read for ${args.relPath}`);
  }
  let canonicalRequested: string;
  let canonicalPresignPath: string;
  try {
    canonicalRequested = normalizeRelPath(args.relPath);
    canonicalPresignPath = normalizeRelPath(presigned.relPath);
  } catch (error) {
    throw new Error(`agent-store baseline probe relPath mismatch for ${args.relPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (canonicalPresignPath !== canonicalRequested) {
    throw new Error(`agent-store baseline probe relPath mismatch for ${args.relPath} (got ${presigned.relPath})`);
  }
  assertPresignedUrlSafe({
    rawUrl: presigned.url,
    relPath: args.relPath,
    validatePresignedUrl: args.validatePresignedUrl,
  });
  const probe = async (range: boolean): Promise<ObjectProbeResponse> => args.fetchImpl(
    presigned.url,
    Object.assign(
      { redirect: "error" as const },
      args.signal !== undefined ? { signal: args.signal } : {},
      range ? { headers: { Range: "bytes=0-0" as const } } : {},
    ),
  );
  let response = await runS3(() => probe(true));
  if (response.status === 416) {
    await response.body?.cancel?.();
    response = await runS3(() => probe(false));
  }
  try {
    if (response.status === 404) {
      return { kind: "absent" };
    }
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`agent-store baseline probe failed for ${args.relPath}: ${response.status}`);
    }
    const etag = normalizeS3Etag(response.headers.get("etag") ?? undefined);
    if (etag.length === 0) {
      throw new Error(`agent-store baseline probe for ${args.relPath} returned no usable etag`);
    }
    return { kind: "exists", etag };
  } finally {
    await response.body?.cancel?.();
  }
}
