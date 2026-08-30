export type PluginIdentifier =
  | { source: "cursor-first-party" | "cursor-third-party"; sourceInfo: { pluginDbId: string } }
  | { source: "claude-plugin" | "user-local" | "extension"; sourceInfo?: unknown };
export function getPluginDbId(identifier: PluginIdentifier): string | undefined {
  switch (identifier.source) { case "cursor-first-party": case "cursor-third-party": return identifier.sourceInfo.pluginDbId; default: return undefined; }
}
