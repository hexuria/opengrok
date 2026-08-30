export interface SandRequestLineage { readonly parentRequestId: string; readonly rootParentRequestId: string; readonly parentAgentToolCallId?: string }
export function sanitizeHeaderValue(value: string): string { return value.replace(/[\r\n]/g, ""); }
export function buildSandRequestLineageHeaders(lineage: SandRequestLineage | null | undefined): Record<string, string> {
  if (lineage == null) return {};
  return {
    "x-parent-request-id": sanitizeHeaderValue(lineage.parentRequestId),
    "x-root-parent-request-id": sanitizeHeaderValue(lineage.rootParentRequestId),
    ...(lineage.parentAgentToolCallId == null ? {} : { "x-parent-agent-tool-call-id": sanitizeHeaderValue(lineage.parentAgentToolCallId) }),
  };
}
