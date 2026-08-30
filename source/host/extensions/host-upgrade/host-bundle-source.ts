export class SandHostBundleSourceError extends Error {}
export const SHORT_GIT_SHA_REGEX = /^[0-9a-f]{7,40}$/;
export const HOST_BUNDLE_BUCKET = "public-asphr-vm-daemon-bucket";
export const HOST_BUNDLE_REGION = "us-east-1";
export const HOST_BUNDLE_PREFIX = "sand-host-bundle";
export const DEFAULT_BASE_URL = `https://${HOST_BUNDLE_BUCKET}.s3.${HOST_BUNDLE_REGION}.amazonaws.com/${HOST_BUNDLE_PREFIX}`;
export const LATEST_VERSION_FILE = "sand-host-bundle-latest.version";
export const VERSION_CACHE_TTL_MS = 10 * 60_000;
export interface HostBundleSource { readonly version: string; loadBundleBytes(): Promise<Uint8Array> }
let cachedVersion: { version: string; at: number } | undefined;
export function hostBundleBaseUrl(): string { const override = process.env.SAND_HOST_BUNDLE_S3_BASE_URL?.trim(); return override != null && override.length > 0 ? override.replace(/\/+$/, "") : DEFAULT_BASE_URL; }
export function latestHostBundleVersionUrl(base = hostBundleBaseUrl()): string { return `${base}/${LATEST_VERSION_FILE}`; }
export function hostBundleTarballUrl(version: string, base = hostBundleBaseUrl()): string { return `${base}/${HOST_BUNDLE_PREFIX}-${version}.tgz`; }
export function clearHostBundleVersionCache(): void { cachedVersion = undefined; }
export async function fetchLatestHostBundleVersion(fetchFn: typeof fetch = fetch): Promise<string | undefined> { if (cachedVersion != null && Date.now() - cachedVersion.at < VERSION_CACHE_TTL_MS) return cachedVersion.version; try { const response = await fetchFn(latestHostBundleVersionUrl()); if (!response.ok) return undefined; const raw = (await response.text()).trim(); if (!SHORT_GIT_SHA_REGEX.test(raw)) return undefined; cachedVersion = { version: raw, at: Date.now() }; return raw; } catch { return undefined; } }
export async function fetchHostBundleTarball(fetchFn: typeof fetch, version: string): Promise<Uint8Array> { if (!SHORT_GIT_SHA_REGEX.test(version)) throw new SandHostBundleSourceError(`sand host bundle: refusing malformed version "${version}"`); const url = hostBundleTarballUrl(version), response = await fetchFn(url); if (!response.ok) throw new SandHostBundleSourceError(`sand host bundle: fetch ${url} failed (status ${response.status})`); const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length === 0) throw new SandHostBundleSourceError(`sand host bundle: fetched empty tarball from ${url}`); return bytes; }
export async function resolveHostBundleSource(fetchFn: typeof fetch = fetch): Promise<HostBundleSource | undefined> { const version = await fetchLatestHostBundleVersion(fetchFn); return version == null ? undefined : { version, loadBundleBytes: () => fetchHostBundleTarball(fetchFn, version) }; }
