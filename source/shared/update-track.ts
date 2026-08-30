export const SAND_UPDATE_TRACKS = ["stable", "nightly", "dogfood"] as const;
export type SandUpdateTrack = (typeof SAND_UPDATE_TRACKS)[number];
export const NIGHTLY_UPDATE_TRACK_DISABLED = true;
const INTERNAL_UPDATE_TRACKS: readonly SandUpdateTrack[] = ["dogfood"];
export function selectableUpdateTracks(unlockInternalTracks: boolean): SandUpdateTrack[] { return SAND_UPDATE_TRACKS.filter((track) => !(NIGHTLY_UPDATE_TRACK_DISABLED && track === "nightly") && (!INTERNAL_UPDATE_TRACKS.includes(track) || unlockInternalTracks)); }
export function availableUpdateTracks(input: { readonly unlockInternalTracks: boolean; readonly effectiveTrack: SandUpdateTrack }): SandUpdateTrack[] { const selectable = selectableUpdateTracks(input.unlockInternalTracks); return SAND_UPDATE_TRACKS.filter((track) => selectable.includes(track) || track === input.effectiveTrack); }
export function isSandUpdateTrack(value: unknown): value is SandUpdateTrack { return typeof value === "string" && (SAND_UPDATE_TRACKS as readonly string[]).includes(value); }
export function coerceToEnabledTrack(track: SandUpdateTrack): SandUpdateTrack { return track === "nightly" ? "stable" : track; }
export function toManagedUpdateTrack(value: unknown): SandUpdateTrack | undefined { if (typeof value !== "string") return undefined; const track = value.trim(); return isSandUpdateTrack(track) && coerceToEnabledTrack(track) === track ? track : undefined; }
export function resolveReleaseTrackGate(config: { readonly releaseTrack?: unknown; readonly unlockInternalTracks?: unknown }) { return { managedTrack: toManagedUpdateTrack(config.releaseTrack), unlockInternalTracks: config.unlockInternalTracks === true }; }
export function resolveEffectiveTrack(input: { readonly managedTrack?: SandUpdateTrack; readonly userOverride?: SandUpdateTrack; readonly buildDefault?: SandUpdateTrack | null }): SandUpdateTrack { return coerceToEnabledTrack(input.managedTrack ?? input.userOverride ?? input.buildDefault ?? "stable"); }
