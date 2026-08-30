import type { Context } from "../../packages/context/core.js";

export const BOX_MCP_UNSUPPORTED_MESSAGE = "Grok Bot's computer is running an older image without MCP support — update it from Settings → Updates → Update Grok Bot's Computer.";
export class SandBoxMcpUnsupportedError extends Error { constructor(message = BOX_MCP_UNSUPPORTED_MESSAGE, options?: ErrorOptions) { super(message, options); this.name = "SandBoxMcpUnsupportedError"; } }
export interface BoxMcpControlClient { loadMcpServers(ctx: Context, request: { mcpConfigJson: string; removeMissing: true }): Promise<{ loadedServerNames: string[] }> }
export function isUnimplementedConnectError(error: unknown): boolean { if (typeof error !== "object" || error == null) return false; const code = (error as { code?: unknown }).code; return code === 12 || code === "unimplemented" || code === "UNIMPLEMENTED"; }
export async function loadBoxMcpServersViaTransport<Transport>(ctx: Context, transport: Transport, configJson: string, createClient: (transport: Transport) => BoxMcpControlClient): Promise<string[]> { const control = createClient(transport); try { return (await control.loadMcpServers(ctx, { mcpConfigJson: configJson, removeMissing: true })).loadedServerNames; } catch (error) { if (isUnimplementedConnectError(error)) throw new SandBoxMcpUnsupportedError(BOX_MCP_UNSUPPORTED_MESSAGE, { cause: error }); throw error; } }
