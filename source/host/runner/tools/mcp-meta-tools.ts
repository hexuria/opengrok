import {
  buildToolCallExecutionTimedOutMessage,
  toolCallExecutionGuardMs,
} from "../../../packages/agent/tools/tool-execution-timeout.js";

export function sandToolCallExecutionTimeoutMs(
  toolName: string,
  isComputerUseSubagent: boolean,
): number {
  return toolCallExecutionGuardMs(isComputerUseSubagent ? "subagent" : toolName, undefined);
}

export class SandToolCallExecutionTimeoutError extends Error {
  override readonly name = "ToolCallExecutionTimeoutError";
  constructor(
    readonly toolName: string,
    readonly executionTimeoutMs: number,
  ) {
    super(buildToolCallExecutionTimedOutMessage({ toolName, executionTimeoutMs }));
  }
}

export interface DynamicToolRegistry {
  resolveToolName(rawArguments: string): string | undefined;
}

export interface StreamingInvocationTool<Context, Handler, Meta, Result> {
  readonly name: string;
  execute(
    context: Context,
    interactionHandler: Handler,
    argumentsStream: AsyncIterable<string>,
    meta: Meta,
  ): Promise<Result>;
}

async function withTimeout<Result>(
  operation: Promise<Result>,
  milliseconds: number,
  createError: () => Error,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(createError()), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export function wrapDynamicInvocationToolWithTimeout<
  Context,
  Handler,
  Meta,
  Result,
  Tool extends StreamingInvocationTool<Context, Handler, Meta, Result>,
>(
  tool: Tool,
  dynamicToolRegistry: DynamicToolRegistry,
  isComputerUseSubagent: boolean,
): Tool {
  return {
    ...tool,
    async execute(
      context: Context,
      interactionHandler: Handler,
      argumentsStream: AsyncIterable<string>,
      meta: Meta,
    ): Promise<Result> {
      let rawArguments = "";
      for await (const chunk of argumentsStream) rawArguments += chunk;
      const effectiveToolName = dynamicToolRegistry.resolveToolName(rawArguments) ?? tool.name;
      const executionTimeoutMs = sandToolCallExecutionTimeoutMs(
        effectiveToolName,
        isComputerUseSubagent,
      );
      const replay = (async function* () {
        yield rawArguments;
      })();
      return withTimeout(
        tool.execute(context, interactionHandler, replay, meta),
        executionTimeoutMs,
        () => new SandToolCallExecutionTimeoutError(effectiveToolName, executionTimeoutMs),
      );
    },
  };
}

export interface McpToolForMeta {
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly plugin?: unknown;
  readonly marketplace?: unknown;
  readonly pluginId?: string;
  readonly marketplaceId?: string;
}

export interface McpToolDescriptor {
  readonly toolName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpDescriptor {
  readonly serverIdentifier: string;
  readonly serverName: string;
  readonly plugin?: unknown;
  readonly marketplace?: unknown;
  readonly pluginDbId?: string;
  readonly marketplaceId?: string;
  readonly tools: McpToolDescriptor[];
}

export function createSandMcpMetaToolOptions(mcpTools: readonly McpToolForMeta[]) {
  const descriptors = new Map<string, Omit<McpDescriptor, "serverIdentifier">>();
  for (const tool of mcpTools) {
    const serverIdentifier = tool.providerIdentifier;
    let descriptor = descriptors.get(serverIdentifier);
    if (descriptor == null) {
      descriptor = {
        serverName: tool.providerIdentifier,
        ...(tool.plugin == null ? {} : { plugin: tool.plugin }),
        ...(tool.marketplace == null ? {} : { marketplace: tool.marketplace }),
        ...(tool.pluginId == null ? {} : { pluginDbId: tool.pluginId }),
        ...(tool.marketplaceId == null ? {} : { marketplaceId: tool.marketplaceId }),
        tools: [],
      };
      descriptors.set(serverIdentifier, descriptor);
    }
    descriptor.tools.push({
      toolName: tool.toolName,
      ...(tool.description == null ? {} : { description: tool.description }),
      ...(tool.inputSchema == null ? {} : { inputSchema: tool.inputSchema }),
    });
  }
  return {
    enabled: true,
    mcpDescriptors: [...descriptors.entries()].map(([serverIdentifier, descriptor]) => ({
      serverIdentifier,
      ...descriptor,
      tools: descriptor.tools.sort((left, right) => left.toolName.localeCompare(right.toolName)),
    })),
  };
}
