const BROWSER_MCP_PROVIDER_IDS = new Set(["cursor-dev-control", "cursor-ide-browser"]);

export const isEqual = <T>(a: readonly T[], b: readonly T[]): boolean => {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
};

export interface McpToolDescriptor { providerIdentifier: string; name: string }

export function getBrowserToolNames(mcpTools: readonly McpToolDescriptor[]): string[] {
  return mcpTools.filter((tool) => BROWSER_MCP_PROVIDER_IDS.has(tool.providerIdentifier)).map((tool) => tool.name);
}

export function getBrowserMcpProviderName(browserTools: readonly string[] | undefined): string | undefined {
  if (!browserTools?.length) return undefined;
  const prefixedTool = browserTools.find((tool) => tool.includes("-browser_"));
  if (prefixedTool === undefined) return undefined;
  const index = prefixedTool.indexOf("-browser_");
  return index > 0 ? prefixedTool.substring(0, index) : undefined;
}
