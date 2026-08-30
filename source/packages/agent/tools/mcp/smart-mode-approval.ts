import { createHash, randomUUID } from "node:crypto";
import { getConversationId } from "../../utils/request-id.js";
import type { Context } from "../../../context/core.js";
import type { SmartModeMcpApprovalStore } from "./smart-mode-approval-store.js";

const SMART_MODE_MCP_APPROVAL_MISSING_CONVERSATION_REASON = "Auto-review MCP approvals require a conversation id";

interface SmartModeMcpApprovalTarget {
  readonly serverIdentifier: string;
  readonly serverName?: string | undefined;
  readonly serverDisplayName?: string | undefined;
  readonly toolName: string;
  readonly mcpMode: string;
  readonly mcpArguments?: unknown;
  readonly toolDefinitionIdentity?: string | undefined;
  readonly toolDefinitionHash?: string | undefined;
  readonly blockReason: string;
}

function normalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForFingerprint);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalizeForFingerprint(entryValue)]),
    );
  }
  return value;
}

export function computeSmartModeMcpApprovalTargetFingerprint(target: SmartModeMcpApprovalTarget): string {
  return createHash("sha256").update(JSON.stringify({
    serverIdentifier: target.serverIdentifier,
    serverName: target.serverName ?? null,
    serverDisplayName: target.serverDisplayName,
    toolName: target.toolName,
    mcpMode: target.mcpMode,
    mcpArguments: normalizeForFingerprint(target.mcpArguments ?? {}),
    toolDefinitionIdentity: target.toolDefinitionIdentity ?? null,
    toolDefinitionHash: target.toolDefinitionHash ?? null,
  })).digest("hex");
}

export async function createSmartModeMcpApprovalRequest(
  ctx: Context,
  store: SmartModeMcpApprovalStore,
  target: SmartModeMcpApprovalTarget,
): Promise<{
  requestId: string;
  fingerprint: string;
  conversationId: string;
  blockReason: string;
}> {
  const conversationId = getConversationId(ctx);
  if (conversationId === undefined) {
    throw new Error(SMART_MODE_MCP_APPROVAL_MISSING_CONVERSATION_REASON);
  }
  const fingerprint = computeSmartModeMcpApprovalTargetFingerprint(target);
  const request = {
    id: randomUUID(),
    conversationId,
    createdAtMs: Date.now(),
    fingerprint,
    blockReason: target.blockReason,
  };
  await store.createPendingRequest(ctx, request);
  return {
    requestId: request.id,
    fingerprint,
    conversationId,
    blockReason: request.blockReason,
  };
}

export async function cancelSmartModeMcpApprovalRequest(
  ctx: Context,
  store: SmartModeMcpApprovalStore,
  requestId: string,
): Promise<void> {
  await store.deletePendingRequest(ctx, requestId);
}
