export const MCP_DISK_CATALOG_MCPS_DIR = "mcps";
export const MCP_DISK_CATALOG_TOOLS_DIR = "tools";
export function parseMcpToolNameFromDiskDefinitionJson(jsonText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.length > 0) return record.name;
    if (typeof record.toolName === "string" && record.toolName.length > 0) return record.toolName;
    return undefined;
  } catch { return undefined; }
}
