import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Context } from "../context/core.js";
import { McpTextContent, McpToolResultContentItem } from "../proto/generated/agent/v1/mcp_exec_pb.js";
import { OutputLocation, type OutputLocation as OutputLocationMessage } from "../proto/generated/agent/v1/utils_pb.js";
import { WriteArgs } from "../proto/generated/agent/v1/write_exec_pb.js";
import type { WriteExecutor } from "./write.js";

const AGENT_TOOLS_DIR = "agent-tools";
const MAX_OUTPUT_FILE_SIZE = 1024 * 1024 * 50;
export const MCP_TEXT_FILE_THRESHOLD_BYTES = 4e4;
export const AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES = 2e4;

export async function materializeMcpTextOutput({
  contentItems,
  thresholdBytes,
  write,
}: {
  readonly contentItems: McpToolResultContentItem[];
  readonly thresholdBytes: number;
  readonly write: (aggregateText: string) => Promise<OutputLocationMessage | undefined>;
}): Promise<McpToolResultContentItem[] | undefined> {
  const inlineTextItems = contentItems.filter(item =>
    item.content.case === "text" && item.content.value.outputLocation === undefined
  );
  const aggregateText = inlineTextItems.map(item =>
    item.content.case === "text" ? item.content.value.text : ""
  ).join("\n\n");
  if (thresholdBytes <= 0 || Buffer.byteLength(aggregateText, "utf8") <= thresholdBytes) {
    return contentItems;
  }
  const outputLocation = await write(aggregateText);
  if (outputLocation === undefined) {
    return undefined;
  }
  const materializedItems: McpToolResultContentItem[] = [];
  let emittedOutputLocation = false;
  for (const item of contentItems) {
    const isInlineText = item.content.case === "text" && item.content.value.outputLocation === undefined;
    if (!isInlineText) {
      materializedItems.push(item);
      continue;
    }
    if (!emittedOutputLocation) {
      materializedItems.push(new McpToolResultContentItem({
        content: {
          case: "text",
          value: new McpTextContent({ text: "", outputLocation }),
        },
      }));
      emittedOutputLocation = true;
    }
  }
  return materializedItems;
}

export async function writeToAgentToolsFile(
  ctx: Context,
  writeExecutor: WriteExecutor,
  {
    content,
    projectDir,
    osPlatform,
    toolCallId,
    maxSize,
  }: {
    readonly content: string;
    readonly projectDir: string;
    readonly osPlatform: string | undefined;
    readonly toolCallId: string;
    readonly maxSize?: number;
  },
): Promise<OutputLocationMessage | undefined> {
  const contentToWrite = content.slice(0, maxSize ?? MAX_OUTPUT_FILE_SIZE);
  const joinFn = osPlatform === "win32" ? path.win32.join : path.posix.join;
  const filePath = joinFn(projectDir, AGENT_TOOLS_DIR, `${randomUUID()}.txt`);
  const lineCount = contentToWrite.split("\n").length;
  const sizeBytes = Buffer.byteLength(contentToWrite, "utf8");
  const result = await writeExecutor.execute(ctx, new WriteArgs({
    path: filePath,
    fileText: contentToWrite,
    toolCallId,
  }));
  switch (result.result.case) {
    case "success":
      return new OutputLocation({
        filePath: result.result.value.path,
        sizeBytes: BigInt(sizeBytes),
        lineCount: BigInt(lineCount),
      });
    case "permissionDenied":
    case "noSpace":
    case "error":
    case "rejected":
    case undefined:
      return undefined;
    default: {
      const _exhaustive: never = result.result;
      throw new Error(`Unhandled result case: ${_exhaustive}`);
    }
  }
}

function formatOutputLocationSize(sizeBytes: bigint): string {
  const total = Number(sizeBytes);
  return total >= 1024 ? `${(total / 1024).toFixed(1)} KB` : `${total} bytes`;
}

export function describeOutputLocation(
  loc: OutputLocationMessage,
  opts?: { readonly leadText?: string },
): string {
  const lead = opts?.leadText ?? "Content";
  return `${lead} written to file: ${loc.filePath}\nSize: ${formatOutputLocationSize(loc.sizeBytes)}, ${loc.lineCount} lines`;
}
