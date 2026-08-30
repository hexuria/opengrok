import { createDeadlinePolicy, realClock } from "../../internal/scheduling.js";

export const AVATAR_REQUEST_TIMEOUT_MS = 10_000;
export const AVATAR_MAX_BYTES = 1024 * 1024;
export const GITHUB_AVATAR_SIZE_PX = 192;
export const GITHUB_AVATAR_HOST = "avatars.githubusercontent.com";

const avatarRequestDeadline = createDeadlinePolicy(realClock, {
  name: "cursor-avatar-request",
  timeoutMs: AVATAR_REQUEST_TIMEOUT_MS,
});
const avatarDataUrlCache = new Map<string, string>();

export interface CursorAuthIdentity { readonly provider: string; readonly subject: string }

export function parseCursorAuthIdentity(authId: string): CursorAuthIdentity | null {
  const separatorIndex = authId.indexOf("|");
  if (separatorIndex <= 0 || separatorIndex >= authId.length - 1) return null;
  return { provider: authId.slice(0, separatorIndex), subject: authId.slice(separatorIndex + 1) };
}

export function githubAvatarUrlForAuthId(authId: string): string | null {
  const identity = parseCursorAuthIdentity(authId);
  if (identity == null || identity.provider !== "github" || !/^[0-9]+$/.test(identity.subject)) return null;
  const url = new URL(`https://${GITHUB_AVATAR_HOST}/u/${identity.subject}`);
  url.searchParams.set("v", "4");
  url.searchParams.set("s", String(GITHUB_AVATAR_SIZE_PX));
  return url.toString();
}

async function responseToImageDataUrl(response: Response): Promise<string | null> {
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!contentType.startsWith("image/")) return null;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES) return null;
  if (response.body == null) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > AVATAR_MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return total > 0 ? `data:${contentType};base64,${Buffer.concat(chunks).toString("base64")}` : null;
}

async function fetchAvatarDataUrl(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  return await avatarRequestDeadline.run(async (signal) =>
    await responseToImageDataUrl(await fetchImpl(url, { signal })));
}

async function fetchHttpsAvatarDataUrl(rawUrl: string, fetchImpl: typeof fetch): Promise<string | null> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  try { return await fetchAvatarDataUrl(parsed.toString(), fetchImpl); } catch { return null; }
}

export async function resolveCursorAvatarDataUrl(
  authId: string | null | undefined,
  options: { readonly fetchImpl?: typeof fetch; readonly preferredUrl?: string } = {},
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const preferred = options.preferredUrl?.trim();
  if (preferred != null && preferred.length > 0) {
    const cached = avatarDataUrlCache.get(preferred);
    if (cached != null) return cached;
    const dataUrl = await fetchHttpsAvatarDataUrl(preferred, fetchImpl);
    if (dataUrl != null) { avatarDataUrlCache.set(preferred, dataUrl); return dataUrl; }
  }
  if (authId == null || authId.length === 0) return null;
  const cached = avatarDataUrlCache.get(authId);
  if (cached != null) return cached;
  const url = githubAvatarUrlForAuthId(authId);
  if (url == null) return null;
  try {
    const dataUrl = await fetchAvatarDataUrl(url, fetchImpl);
    if (dataUrl != null) avatarDataUrlCache.set(authId, dataUrl);
    return dataUrl;
  } catch { return null; }
}

export function clearCursorAvatarCacheForTesting(): void { avatarDataUrlCache.clear(); }
