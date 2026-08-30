import type { McpInstructions } from "../../proto/generated/agent/v1/mcp_pb.js";
import { jsx } from "../../prompt-jsx/jsx-runtime.js";
import type { PromptNode } from "../../prompt-jsx/jsx-runtime.js";

export function McpInstructionsSection({ mcpEntries }: { readonly mcpEntries: readonly McpInstructions[] }): PromptNode {
  return jsx("section", {
    title: "mcp_instructions",
    description: "Instructions provided by MCP servers to help use them properly",
    children: mcpEntries.map((entry) => `Server: ${entry.serverName ?? "unknown"}\n${entry.instructions}`).join("\n\n"),
  });
}
