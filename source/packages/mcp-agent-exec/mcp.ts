export function isMcpToolNotFoundError(error: unknown): error is McpToolNotFoundError {
  if (error instanceof McpToolNotFoundError) {
    return true;
  }
  if (!(error instanceof Error) || error.name !== "McpToolNotFoundError") {
    return false;
  }
  const candidate = error as Error & {
    readonly toolName?: unknown;
    readonly availableTools?: unknown;
  };
  return typeof candidate.toolName === "string" && Array.isArray(candidate.availableTools);
}

export class McpToolNotFoundError extends Error {
  readonly toolName: string;
  readonly availableTools: string[];

  constructor(toolName: string, availableTools: string[]) {
    super(`Tool ${toolName} not found, available tools: ${availableTools.join(", ")}`);
    this.toolName = toolName;
    this.availableTools = availableTools;
    this.name = "McpToolNotFoundError";
  }
}
