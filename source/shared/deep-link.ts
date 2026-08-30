import { buildSandPluginDeepLink, isSandDeepLinkPluginId, SAND_PLUGIN_DEEP_LINK_PATH } from "./desktop.js";

// Two URL schemes on purpose - do not consolidate:
// - "sand" is the scheme Cursor's official auth flow redirects to (the OAuth
//   callback registered with their service targets sand://). Dropping or
//   renaming it silently breaks Cursor sign-in on this Mac.
// - "opengrok" is OUR brand scheme, used for links we mint ourselves (e.g.
//   shareable per-message URLs). Both parse identically below.
export const SAND_DEEP_LINK_SCHEME = "sand"; export const OPENGROK_DEEP_LINK_SCHEME = "opengrok"; export const SAND_DEEP_LINK_AUTHORITY = "app"; export const SAND_HTTPS_DEEP_LINK_ORIGIN = "https://cursor.com"; export const SAND_HTTPS_DEEP_LINK_PATH_PREFIX = "/sand/link"; export const SAND_DEEP_LINK_MAX_LENGTH = 2_048;
const CUSTOM_INFO_ROUTE_PATH = "/v1/info"; const CUSTOM_OPEN_ROUTE_PATH = "/v1/open"; const CUSTOM_MESSAGE_ROUTE_PATH = "/v1/message"; const HTTPS_INFO_ROUTE_PATH = `${SAND_HTTPS_DEEP_LINK_PATH_PREFIX}${CUSTOM_INFO_ROUTE_PATH}`; const HTTPS_PLUGIN_ADD_ROUTE_PATH = `${SAND_HTTPS_DEEP_LINK_PATH_PREFIX}${SAND_PLUGIN_DEEP_LINK_PATH}`; const HTTPS_OPEN_ROUTE_PATH = `${SAND_HTTPS_DEEP_LINK_PATH_PREFIX}${CUSTOM_OPEN_ROUTE_PATH}`;
/** Collections links are minted by this app only, so they never get an https twin. */
export const CUSTOM_COLLECTION_ROUTE_PATH = "/v1/collection";
export type SandDeepLink = { readonly version: 1; readonly route: "info"; readonly topic: "deep-links"; readonly source: "protocol" | "https" } | { readonly version: 1; readonly route: "plugin-add"; readonly pluginId: string; readonly source: "protocol" | "https" } | { readonly version: 1; readonly route: "open"; readonly source: "protocol" | "https" } | { readonly version: 1; readonly route: "message"; readonly agentId: string; readonly messageId: string; readonly indexHint?: number; readonly source: "protocol" | "https" } | { readonly version: 1; readonly route: "collection"; readonly collectionId: string; readonly source: "protocol" };
export interface ParsedSandDeepLink { readonly link: SandDeepLink; readonly canonicalUrl: string }
function isPrintableAscii(value: string): boolean { for (let index = 0; index < value.length; index += 1) { const code = value.charCodeAt(index); if (code < 33 || code > 126) return false; } return true; }
function hasValidPercentEncoding(value: string): boolean { return !/%(?![0-9A-Fa-f]{2})/.test(value); }
function hasCanonicalPathSection(raw: string): boolean { const queryStart = raw.indexOf("?"); const beforeQuery = queryStart === -1 ? raw : raw.slice(0, queryStart); return !beforeQuery.includes("%") && !/\/\.{1,2}(?:\/|$)/.test(beforeQuery); }
function readAllowlistedQuery(url: URL, allowlist: Readonly<Record<string, readonly string[]>>): Record<string, string> | null { const seen: Record<string, string> = {}; for (const [key, value] of url.searchParams) { const allowed = allowlist[key]; if (allowed == null || key in seen || !allowed.includes(value)) return null; seen[key] = value; } for (const key of Object.keys(allowlist)) if (!(key in seen)) return null; return seen; }
export const SAND_OPEN_DEEP_LINK_URL = `${SAND_DEEP_LINK_SCHEME}://${SAND_DEEP_LINK_AUTHORITY}${CUSTOM_OPEN_ROUTE_PATH}`;
export function canonicalSandDeepLinkUrl(link: SandDeepLink): string { switch (link.route) { case "info": return `${SAND_DEEP_LINK_SCHEME}://${SAND_DEEP_LINK_AUTHORITY}/v1/info?topic=${link.topic}`; case "plugin-add": return buildSandPluginDeepLink(link.pluginId); case "open": return SAND_OPEN_DEEP_LINK_URL; case "message": return buildSandMessageDeepLinkUrl(link.agentId, link.messageId); case "collection": return buildCollectionDeepLinkUrl(link.collectionId); } }
function parsePluginAddLink(url: URL, source: "protocol" | "https"): ParsedSandDeepLink | null { const entries = [...url.searchParams]; if (entries.length !== 1) return null; const entry = entries[0]; if (entry == null || entry[0] !== "id" || !isSandDeepLinkPluginId(entry[1])) return null; const link: SandDeepLink = { version: 1, route: "plugin-add", pluginId: entry[1], source }; return { link, canonicalUrl: canonicalSandDeepLinkUrl(link) }; }
export const DEEP_LINK_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
/** Shareable collection link: opens the Collections window on that collection. */
export function buildCollectionDeepLinkUrl(collectionId: string): string {
  return `${OPENGROK_DEEP_LINK_SCHEME}://${SAND_DEEP_LINK_AUTHORITY}${CUSTOM_COLLECTION_ROUTE_PATH}?id=${encodeURIComponent(collectionId)}`;
}
function parseCollectionLink(url: URL): ParsedSandDeepLink | null {
  const entries = [...url.searchParams];
  if (entries.length !== 1) return null;
  const id = url.searchParams.get("id");
  if (id == null || !DEEP_LINK_ID_PATTERN.test(id)) return null;
  const link: SandDeepLink = { version: 1, route: "collection", collectionId: id, source: "protocol" };
  return { link, canonicalUrl: canonicalSandDeepLinkUrl(link) };
}
/** Shareable per-message link: opens the agent's channel and scrolls to the message. */
export function buildSandMessageDeepLinkUrl(agentId: string, messageId: string): string {
  return `${OPENGROK_DEEP_LINK_SCHEME}://${SAND_DEEP_LINK_AUTHORITY}${CUSTOM_MESSAGE_ROUTE_PATH}?agent=${encodeURIComponent(agentId)}&id=${encodeURIComponent(messageId)}`;
}
function parseMessageLink(url: URL, source: "protocol" | "https"): ParsedSandDeepLink | null {
  const entries = [...url.searchParams];
  if (entries.length !== 2 && entries.length !== 3) return null;
  const agent = url.searchParams.get("agent");
  const id = url.searchParams.get("id");
  const indexHint = url.searchParams.get("i");
  if (agent == null || id == null || !DEEP_LINK_ID_PATTERN.test(agent) || !DEEP_LINK_ID_PATTERN.test(id)) return null;
  if (entries.length === 3 && (indexHint == null || !/^\d{1,7}$/.test(indexHint))) return null;
  const link: SandDeepLink = { version: 1, route: "message", agentId: agent, messageId: id, ...(indexHint != null ? { indexHint: Number(indexHint) } : {}), source };
  return { link, canonicalUrl: canonicalSandDeepLinkUrl(link) };
}
function parseOpenLink(url: URL, source: "protocol" | "https"): ParsedSandDeepLink | null { if (readAllowlistedQuery(url, {}) == null) return null; const link: SandDeepLink = { version: 1, route: "open", source }; return { link, canonicalUrl: canonicalSandDeepLinkUrl(link) }; }
export function parseSandDeepLink(raw: unknown): ParsedSandDeepLink | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > SAND_DEEP_LINK_MAX_LENGTH || !isPrintableAscii(raw) || raw.includes("#") || raw.includes("\\") || !hasValidPercentEncoding(raw) || !hasCanonicalPathSection(raw)) return null;
  const lower = raw.toLowerCase(); const source = lower.startsWith(`${SAND_DEEP_LINK_SCHEME}:`) || lower.startsWith(`${OPENGROK_DEEP_LINK_SCHEME}:`) ? "protocol" : lower.startsWith("https:") ? "https" : null; if (source == null) return null;
  let url: URL; try { url = new URL(raw); } catch { return null; } if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (source === "protocol") { if ((url.protocol !== `${SAND_DEEP_LINK_SCHEME}:` && url.protocol !== `${OPENGROK_DEEP_LINK_SCHEME}:`) || url.host !== SAND_DEEP_LINK_AUTHORITY) return null; if (url.pathname === CUSTOM_MESSAGE_ROUTE_PATH) return parseMessageLink(url, source); if (url.pathname === CUSTOM_COLLECTION_ROUTE_PATH) return parseCollectionLink(url); if (url.pathname === SAND_PLUGIN_DEEP_LINK_PATH) return parsePluginAddLink(url, source); if (url.pathname === CUSTOM_OPEN_ROUTE_PATH) return parseOpenLink(url, source); if (url.pathname !== CUSTOM_INFO_ROUTE_PATH) return null; }
  else { if (url.protocol !== "https:" || url.host !== new URL(SAND_HTTPS_DEEP_LINK_ORIGIN).host) return null; if (url.pathname === HTTPS_PLUGIN_ADD_ROUTE_PATH) return parsePluginAddLink(url, source); if (url.pathname === HTTPS_OPEN_ROUTE_PATH) return parseOpenLink(url, source); if (url.pathname !== HTTPS_INFO_ROUTE_PATH) return null; }
  if (readAllowlistedQuery(url, { topic: ["deep-links"] }) == null) return null; const link: SandDeepLink = { version: 1, route: "info", topic: "deep-links", source }; return { link, canonicalUrl: canonicalSandDeepLinkUrl(link) };
}
