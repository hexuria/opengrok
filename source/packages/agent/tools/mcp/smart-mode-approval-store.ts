import { createResource } from "../../../agent-exec/resource-provider.js";
import type { Context } from "../../../context/core.js";
import { z } from "zod";

const SMART_MODE_MCP_APPROVAL_TTL_SECONDS = 24 * 60 * 60;
const SMART_MODE_MCP_APPROVAL_TTL_MS = SMART_MODE_MCP_APPROVAL_TTL_SECONDS * 1e3;

export interface SmartModeMcpApprovalRequestRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly createdAtMs: number;
  readonly fingerprint: string;
  readonly blockReason: string;
}

export interface SmartModeMcpApprovalStore {
  createPendingRequest(ctx: Context, request: SmartModeMcpApprovalRequestRecord): Promise<void>;
  deletePendingRequest(ctx: Context, requestId: string): Promise<void>;
}

const smartModeMcpApprovalRequestRecordSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  createdAtMs: z.number(),
  fingerprint: z.string(),
  blockReason: z.string(),
});

export const smartModeMcpApprovalStoreResource = createResource<SmartModeMcpApprovalStore>(
  () => {
    throw new Error("Auto-review MCP approval store is not configured");
  },
  () => {},
);

void smartModeMcpApprovalRequestRecordSchema;
void SMART_MODE_MCP_APPROVAL_TTL_MS;
