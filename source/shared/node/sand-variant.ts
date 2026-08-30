export type SandVariant = "sand-dev" | "sand-lab" | "sand";

export function isSandPackaged(): boolean { return process.env.SAND_PACKAGED === "1"; }
export function isSandLabBuild(): boolean { return process.env.SAND_LAB === "1"; }
export function getSandVariant(): SandVariant {
  return !isSandPackaged() ? "sand-dev" : isSandLabBuild() ? "sand-lab" : "sand";
}

