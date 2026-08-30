import { SAND_PRODUCT_DISPLAY_NAME } from "../../shared/product-name.js";
import { parseVersion } from "./update-version.js";

export const SAND_UPDATE_PLATFORM = "darwin-arm64";
export const SAND_UPDATE_PLATFORM_DARWIN_X64 = "darwin-x64";
export const SAND_UPDATE_PLATFORM_WIN32 = "win32-x64-user";
export const SAND_UPDATE_PLATFORM_WIN32_ARM64 = "win32-arm64-user";
export const DEFAULT_UPDATE_BASE_URL = "https://api2.cursor.sh/updates";
export type UpdateTrack = "stable" | "nightly" | "dogfood";

export function resolveUpdatePlatform(platform: NodeJS.Platform, arch: string): string { if (platform === "win32") return arch === "arm64" ? SAND_UPDATE_PLATFORM_WIN32_ARM64 : SAND_UPDATE_PLATFORM_WIN32; if (platform === "darwin" && arch === "x64") return SAND_UPDATE_PLATFORM_DARWIN_X64; return SAND_UPDATE_PLATFORM; }
export function updateResponseKind(platform: string): "squirrel" | "iupdate" { return platform.startsWith("darwin") ? "squirrel" : "iupdate"; }
export function appNameForTrack(track: UpdateTrack): string { return track === "stable" ? "sand" : track === "nightly" ? "sand-nightly" : "sand-dogfood"; }

export class UpdateHttpStatusError extends Error { readonly status: number; constructor(status: number, url: string) { super(`Update server returned HTTP ${status} for ${url}`); this.status = status; this.name = "UpdateHttpStatusError"; } }
export class UpdateResponseFormatError extends Error { constructor(detail: string) { super(`Malformed update response: ${detail}`); this.name = "UpdateResponseFormatError"; } }

export function buildUpdateRequestUrl(baseUrl: string, track: UpdateTrack, currentVersion: string, machineId: string, platform = SAND_UPDATE_PLATFORM): string {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/update/${platform}/${appNameForTrack(track)}/${currentVersion}/${machineId}/stable`;
  const currentTrack = parseVersion(currentVersion)?.prerelease[0] ?? "stable";
  return currentTrack === track ? url : `${url}?trackChanged=1`;
}
function validUrl(value: unknown): value is string { if (typeof value !== "string") return false; try { new URL(value); return true; } catch { return false; } }
export function parseUpdateResponse(payload: unknown, kind: "squirrel" | "iupdate" = "squirrel") {
  if (typeof payload !== "object" || payload === null) throw new UpdateResponseFormatError("expected an object");
  const value = payload as Record<string, unknown>;
  if (!validUrl(value.url)) throw new UpdateResponseFormatError("url must be a valid URL");
  if (kind === "iupdate") {
    if (typeof value.version !== "string" || value.version.length === 0) throw new UpdateResponseFormatError("version must be a non-empty string");
    if (value.sha256hash !== undefined && (typeof value.sha256hash !== "string" || value.sha256hash.length === 0)) throw new UpdateResponseFormatError("sha256hash must be a non-empty string");
    return { version: value.version, url: value.url, ...(value.sha256hash == null ? {} : { sha256: value.sha256hash }) };
  }
  if (typeof value.name !== "string" || value.name.length === 0) throw new UpdateResponseFormatError("name must be a non-empty string");
  return { version: value.name, url: value.url, name: `${SAND_PRODUCT_DISPLAY_NAME} ${value.name}` };
}
