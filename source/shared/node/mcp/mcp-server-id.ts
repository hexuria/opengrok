import { SandMcpConfigError } from "./mcp-config-error.js";
const MCP_SERVER_ID_PATTERN = /^[1-9]\d*$/;
export function isMcpServerId(rawId: string): boolean { return MCP_SERVER_ID_PATTERN.test(rawId.trim()); }
export function validateMcpServerId(rawId: string): string { const id = rawId.trim(); if (!isMcpServerId(id)) throw new SandMcpConfigError("MCP server ID must be a positive decimal string."); return id; }
export function parseInt32McpServerId(rawId: string): number { const parsed = Number(validateMcpServerId(rawId)); if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) throw new SandMcpConfigError("MCP server ID is outside the supported range."); return parsed; }
