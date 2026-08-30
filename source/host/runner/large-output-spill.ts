import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  MCP_TEXT_FILE_THRESHOLD_BYTES,
  materializeMcpTextOutput,
} from "../../packages/agent-exec/agent-tools-file.js";
import type { McpResult } from "../../packages/proto/generated/agent/v1/mcp_exec_pb.js";
import { OutputLocation } from "../../packages/proto/generated/agent/v1/utils_pb.js";

export const SAND_SHELL_FILE_OUTPUT_THRESHOLD_BYTES = BigInt(MCP_TEXT_FILE_THRESHOLD_BYTES);
export const MAX_OUTPUT_FILE_SIZE = 1_000_000;
export const AGENT_TOOLS_DIR = ".sand/tools";

export const isLargeOutputSpillEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.SAND_DISABLE_LARGE_OUTPUT_SPILL !== "1";

export function createSandMcpTextSpiller<C>(opts: {
  readonly thresholdBytes?: number;
  readonly uploadTextFile: (ctx: C, path: string, data: Uint8Array) => Promise<void>;
}) {
  const thresholdBytes = opts.thresholdBytes ?? MCP_TEXT_FILE_THRESHOLD_BYTES;
  return async (ctx: C, result: McpResult): Promise<McpResult> => {
    if (result.result.case !== "success") {
      return result;
    }

    const materialized = await materializeMcpTextOutput({
      contentItems: result.result.value.content,
      thresholdBytes,
      write: async aggregateText => {
        try {
          const relativePath = path.posix.join(AGENT_TOOLS_DIR, `${randomUUID()}.txt`);
          const capped = aggregateText.length > MAX_OUTPUT_FILE_SIZE
            ? aggregateText.slice(0, MAX_OUTPUT_FILE_SIZE)
            : aggregateText;
          const data = new TextEncoder().encode(capped);
          await opts.uploadTextFile(ctx, relativePath, data);
          return new OutputLocation({
            filePath: relativePath,
            sizeBytes: BigInt(data.byteLength),
            lineCount: BigInt(capped.split("\n").length),
          });
        } catch {
          return undefined;
        }
      },
    });

    if (materialized === undefined || materialized === result.result.value.content) {
      return result;
    }

    const spilled = result.clone();
    if (spilled.result.case === "success") {
      spilled.result.value.content = materialized;
    }
    return spilled;
  };
}
