import {
  McpError,
  McpResult,
  McpSuccess,
  McpTextContent,
  McpToolResultContentItem,
} from "../../../packages/proto/generated/agent/v1/mcp_exec_pb.js";
import type {
  McpContentItem,
  McpResultFactory,
  McpResultLike,
} from "./mcp-image-assets.js";

/** Exact constructor projection used by the shipped shared MCP runtime. */
export const generatedMcpResultFactory = {
  textItem(text: string): McpToolResultContentItem {
    return new McpToolResultContentItem({
      content: {
        case: "text",
        value: new McpTextContent({ text }),
      },
    });
  },

  success<T extends McpResultLike>(original: T, content: McpContentItem[]): T {
    const current = original.result.value as {
      isError?: boolean;
      structuredContent?: McpSuccess["structuredContent"];
    };
    return new McpResult({
      result: {
        case: "success",
        value: new McpSuccess({
          content: content as McpToolResultContentItem[],
          isError: current.isError ?? false,
          ...(current.structuredContent === undefined
            ? {}
            : { structuredContent: current.structuredContent }),
        }),
      },
    }) as unknown as T;
  },

  error(message: string): McpResult {
    return new McpResult({
      result: {
        case: "error",
        value: new McpError({ error: message }),
      },
    });
  },
} satisfies McpResultFactory & {
  error(message: string): McpResult;
};
