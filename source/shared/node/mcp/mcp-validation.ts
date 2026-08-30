import { SandMcpConfigError } from "./mcp-config-error.js"; import type { McpServerConfig } from "./mcp-display-runtime.js";
const RESERVED_SERVER_NAMES = new Set(["__proto__", "constructor", "prototype"]);
export function getTransport(config: McpServerConfig): "stdio" | "sse" | "http" { return "command" in config ? "stdio" : config.type === "sse" ? "sse" : "http"; }
export function getCommand(config: McpServerConfig): string | undefined { return "command" in config ? [config.command, ...(config.args ?? [])].join(" ") : undefined; }
export function validateServerName(raw: string): string { const name = raw.trim(); if (name.length === 0) throw new SandMcpConfigError("MCP server name is required."); if (RESERVED_SERVER_NAMES.has(name)) throw new SandMcpConfigError(`MCP server name "${name}" is reserved.`); if (name.includes("/") || name.includes("\\") || name.includes("\0")) throw new SandMcpConfigError("MCP server names cannot include slashes or null bytes."); if (name.includes("--")) throw new SandMcpConfigError('MCP server names cannot include "--".'); return name; }
export function parseServerConfig(configJson: string, parse: (value: unknown) => McpServerConfig): McpServerConfig { return parse(JSON.parse(configJson) as unknown); }
export function toJsonArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [
    key,
    typeof value === "object" && value != null && "toJson" in value && typeof value.toJson === "function"
      ? value.toJson()
      : value,
  ]));
}
