export function parseIgnoreRules(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trimStart())
    .filter((line) => line !== "" && !line.startsWith("#"));
}
