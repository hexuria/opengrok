export const SAND_UPDATE_TRACKS = ["stable", "nightly", "dogfood"] as const;
export type SandUpdateTrack = (typeof SAND_UPDATE_TRACKS)[number];

export function isSandUpdateTrack(value: unknown): value is SandUpdateTrack {
  return value === "stable" || value === "nightly" || value === "dogfood";
}
