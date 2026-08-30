import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request } from "node:https";
import net from "node:net";
import { createDeadlinePolicy, realClock } from "../../../internal/scheduling.js";
import { hasNonPublicHostnameSuffix } from "../../../shared/link-preview-policy.js";
import { SAND_PRODUCT_HTTP_TOKEN } from "../../../shared/product-name.js";

export class SandLinkPreviewError extends Error {}
export const MAX_URL_LENGTH = 2_048;
export const MAX_REDIRECTS = 5;
export const LINK_PREVIEW_USER_AGENT = `${SAND_PRODUCT_HTTP_TOKEN}-LinkPreview/1.0`;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LINK_PREVIEW_DNS_DEADLINE = createDeadlinePolicy(realClock, { name: "link-preview-dns-lookup", timeoutMs: 3_000 });
const LINK_PREVIEW_REQUEST_DEADLINE = createDeadlinePolicy(realClock, { name: "link-preview-request", timeoutMs: 8_000 });
const BLOCKED_HOSTNAMES = new Set(["localhost"]);
const blockList = new net.BlockList();
for (const [network, prefix, family] of [
  ["0.0.0.0",8,"ipv4"],["10.0.0.0",8,"ipv4"],["100.64.0.0",10,"ipv4"],["127.0.0.0",8,"ipv4"],["169.254.0.0",16,"ipv4"],["172.16.0.0",12,"ipv4"],["192.0.0.0",24,"ipv4"],["192.0.2.0",24,"ipv4"],["192.88.99.0",24,"ipv4"],["192.168.0.0",16,"ipv4"],["198.18.0.0",15,"ipv4"],["198.51.100.0",24,"ipv4"],["203.0.113.0",24,"ipv4"],["224.0.0.0",4,"ipv4"],["240.0.0.0",4,"ipv4"],
  ["::",127,"ipv6"],["64:ff9b::",96,"ipv6"],["64:ff9b:1::",48,"ipv6"],["100::",64,"ipv6"],["2001::",32,"ipv6"],["2001:db8::",32,"ipv6"],["2002::",16,"ipv6"],["fc00::",7,"ipv6"],["fe80::",10,"ipv6"],["fec0::",10,"ipv6"],["ff00::",8,"ipv6"]
] as const) blockList.addSubnet(network, prefix, family);

export function normalizeHostname(hostname: string): string { const value = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname; return value.toLowerCase().replace(/\.$/, ""); }
export function isBlockedHostname(hostname: string): boolean { return hostname.length === 0 || !hostname.includes(".") || BLOCKED_HOSTNAMES.has(hostname) || hasNonPublicHostnameSuffix(hostname); }
export function isBlockedLinkPreviewIp(address: string): boolean { const family = net.isIP(address); return family === 4 ? blockList.check(address, "ipv4") : family === 6 ? blockList.check(address, "ipv6") : true; }
export function parseSafeLinkPreviewUrl(rawUrl: string): URL {
  if (rawUrl.length > MAX_URL_LENGTH) throw new SandLinkPreviewError("Link preview URL is too long.");
  let parsed: URL; try { parsed = new URL(rawUrl); } catch { throw new SandLinkPreviewError("Link preview URL must be an absolute HTTPS URL."); }
  if (parsed.protocol !== "https:") throw new SandLinkPreviewError("Link previews require HTTPS.");
  if (parsed.username !== "" || parsed.password !== "") throw new SandLinkPreviewError("Link preview URLs cannot contain credentials.");
  if (parsed.port !== "" && parsed.port !== "443") throw new SandLinkPreviewError("Link preview URLs cannot use a custom port.");
  const hostname = normalizeHostname(parsed.hostname), family = net.isIP(hostname);
  if (family === 0 && isBlockedHostname(hostname)) throw new SandLinkPreviewError("Link preview URL has a non-public hostname.");
  if (family !== 0 && isBlockedLinkPreviewIp(hostname)) throw new SandLinkPreviewError("Link preview URL has a non-public IP address.");
  return parsed;
}
export interface SafeConnectionTarget { readonly connectHost: string; readonly hostHeader: string; readonly servername?: string }
function hostHeaderFor(url: URL): string { const hostname = normalizeHostname(url.hostname), formatted = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname; return url.port === "" ? formatted : `${formatted}:${url.port}`; }
export async function getSafeLinkPreviewConnectionTarget(url: URL, resolver: typeof lookup = lookup): Promise<SafeConnectionTarget> {
  const parsed = parseSafeLinkPreviewUrl(url.toString()), hostname = normalizeHostname(parsed.hostname), family = net.isIP(hostname);
  if (family !== 0) return { connectHost: hostname, hostHeader: hostHeaderFor(parsed) };
  const addresses = await LINK_PREVIEW_DNS_DEADLINE.run(() => resolver(hostname, { all: true, verbatim: true }));
  if (addresses.length === 0) throw new SandLinkPreviewError("Link preview hostname did not resolve.");
  if (addresses.some(({ address }) => isBlockedLinkPreviewIp(address))) throw new SandLinkPreviewError("Link preview hostname resolves to a non-public address.");
  const pinned = addresses.find(({ family: f }) => f === 4) ?? addresses.find(({ family: f }) => f === 6) ?? addresses[0];
  if (pinned == null) throw new SandLinkPreviewError("Link preview hostname did not resolve.");
  return { connectHost: pinned.address, hostHeader: hostHeaderFor(parsed), servername: hostname };
}
function firstHeaderValue(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
export function resolveSafeLinkPreviewRedirect(currentUrl: URL, location: string): URL { return parseSafeLinkPreviewUrl(new URL(location, currentUrl).toString()); }
export interface LinkPreviewResponse { readonly statusCode: number; readonly headers: IncomingHttpHeaders; readonly body: Buffer; readonly finalUrl: string; readonly redirectUrls: readonly string[] }
async function requestOnce(url: URL, maxBytes: number, accept: string, truncateAtByteLimit: boolean) {
  const target = await getSafeLinkPreviewConnectionTarget(url);
  return await LINK_PREVIEW_REQUEST_DEADLINE.run((signal) => new Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    let settled = false;
    let removeAbortListener = () => {};
    const settle = (complete: () => void) => { if (settled) return; settled = true; removeAbortListener(); complete(); };
    const succeed = (result: { statusCode: number; headers: IncomingHttpHeaders; body: Buffer }) => settle(() => resolve(result));
    const fail = (error: unknown) => settle(() => reject(error));
    const req = request({ method: "GET", host: target.connectHost, path: `${url.pathname}${url.search}`, port: 443, servername: target.servername, headers: { accept, "accept-encoding": "identity", connection: "close", host: target.hostHeader, "user-agent": LINK_PREVIEW_USER_AGENT } }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const result = (body: Buffer) => ({ statusCode, headers: response.headers, body });
      if (REDIRECT_STATUSES.has(statusCode)) { response.destroy(); succeed(result(Buffer.alloc(0))); return; }
      const contentLength = Number.parseInt(firstHeaderValue(response.headers["content-length"]) ?? "", 10);
      const declaredBodyIsTooLarge = Number.isFinite(contentLength) && contentLength > maxBytes;
      if (!truncateAtByteLimit && declaredBodyIsTooLarge) { response.destroy(); fail(new Error("Link preview response exceeded its byte limit.")); return; }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const stop = () => { response.destroy(); req.destroy(); };
      const succeedWithBody = () => succeed(result(Buffer.concat(chunks)));
      response.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        const remainingBytes = maxBytes - totalBytes;
        const chunkOverflowsLimit = bytes.byteLength > remainingBytes;
        if (chunkOverflowsLimit) {
          if (!truncateAtByteLimit) { stop(); fail(new Error("Link preview response exceeded its byte limit.")); return; }
          if (remainingBytes > 0) chunks.push(bytes.subarray(0, remainingBytes));
          stop(); succeedWithBody(); return;
        }
        chunks.push(bytes);
        totalBytes += bytes.byteLength;
        if (truncateAtByteLimit && totalBytes === maxBytes) { stop(); succeedWithBody(); }
      });
      response.on("end", succeedWithBody);
      response.on("error", fail);
    });
    const abort = () => { req.destroy(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
    req.on("error", fail);
    req.end();
  }));
}
export async function fetchSafeLinkPreviewResource(rawUrl: string, options: { readonly maxBytes: number; readonly accept: string; readonly truncateAtByteLimit?: boolean }): Promise<LinkPreviewResponse> {
  let currentUrl = parseSafeLinkPreviewUrl(rawUrl); const redirectUrls: string[] = [];
  for (let count = 0;; count += 1) {
    if (count > MAX_REDIRECTS) throw new SandLinkPreviewError("Too many redirects while fetching link preview.");
    const response = await requestOnce(currentUrl, options.maxBytes, options.accept, options.truncateAtByteLimit ?? false);
    if (!REDIRECT_STATUSES.has(response.statusCode)) return { ...response, finalUrl: currentUrl.toString(), redirectUrls };
    const location = firstHeaderValue(response.headers.location);
    if (location == null) return { ...response, finalUrl: currentUrl.toString(), redirectUrls };
    currentUrl = resolveSafeLinkPreviewRedirect(currentUrl, location); redirectUrls.push(currentUrl.toString());
  }
}
