export const MCP_CUSTOM_INSTRUCTIONS_MAX_LENGTH = 500;
export function clampMcpCustomInstruction(raw: string): string { return raw.length > MCP_CUSTOM_INSTRUCTIONS_MAX_LENGTH ? raw.slice(0, MCP_CUSTOM_INSTRUCTIONS_MAX_LENGTH) : raw; }
const DEFAULT_MCP_CONNECTOR_INSTRUCTIONS = new Map([["hex", "When using Hex, get the underlying numbers as data: download/export the results as CSV or use the data the connector returns, and analyze those raw values directly. Don't read rendered charts or graphs from screenshots (computer-use chart reading is unreliable) — work from the actual data."]]);
export function getDefaultMcpCustomInstruction(serverName: string): string { return DEFAULT_MCP_CONNECTOR_INSTRUCTIONS.get(serverName.trim().toLowerCase()) ?? ""; }
export function resolveMcpCustomInstruction(serverName: string, storedInstruction: string | undefined): string { return storedInstruction === undefined ? getDefaultMcpCustomInstruction(serverName) : storedInstruction.trim(); }
export function formatMcpCustomInstructionToolNote(serverName: string, instructions: string): string { return `Custom instructions for the "${serverName}" connector (always follow them when using this tool):\n${instructions.trim()}`; }
export function selectConnectedMcpCustomInstructions(connectedServerNames: readonly string[], instructionsByServer: ReadonlyMap<string, string>) {
  const entries: Array<{ name: string; instructions: string }> = [];
  for (const name of new Set(connectedServerNames)) {
    const instructions = resolveMcpCustomInstruction(name, instructionsByServer.get(name));
    if (instructions.length > 0) entries.push({ name, instructions });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
export function buildMcpCustomInstructionsSystemPromptSection(connectedServerNames: readonly string[], instructionsByServer: ReadonlyMap<string, string>): string | null {
  const entries = selectConnectedMcpCustomInstructions(connectedServerNames, instructionsByServer);
  return entries.length === 0 ? null : ["## Connector custom instructions", "Custom instructions are configured for some connected tools (MCP connectors). Always follow the matching instruction whenever you use that connector's tools, even before your first call to it:", ...entries.map((entry) => `- ${entry.name}: ${entry.instructions}`)].join("\n");
}
