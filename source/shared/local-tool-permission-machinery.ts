import { createKey, type ContextKey } from "../packages/context/core.js";
import type { SandLocalToolAction } from "./local-tool-permission.js";

export const SAND_LOCAL_TOOL_ASK_TTL_MS = 10 * 60 * 1_000;
export const SAND_LOCAL_TOOLS_DISABLED_MESSAGE = 'Local tools are turned off. The user has set local tool access to "Never", so ExternalShell, ExternalRead, AwaitExternalShell, CopyToBox, and CopyFromBox cannot run on their computer. Do not retry them while this setting remains "Never". Use your own computer instead (Shell, Read, AwaitShell), or ask the user to change the setting in Settings → Agent → Execution on Local Computer. If they change it away from "Never", you may try again.';
export const SAND_LOCAL_TOOLS_DENIED_MESSAGE = "The user declined this action on their computer. Do not retry it. Do something else, use your own computer instead (Shell, Read, AwaitShell), or ask them what they would prefer.";
export const SAND_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE = "The request to run this on the user's computer went unanswered, so nothing ran. Use your own computer instead (Shell, Read, AwaitShell), or tell the user you are waiting on their approval.";
export const SAND_LOCAL_TOOLS_ASK_UNAVAILABLE_MESSAGE = "Using the user's computer needs their permission, and this conversation has nowhere to ask for it. Use your own computer instead (Shell, Read, AwaitShell), or do this from a direct chat with the user.";
export const SAND_LOCAL_TOOLS_UNDESCRIBABLE_MESSAGE = "Grok Bot could not describe that request to the user's computer, so it could not ask permission for it and did not run it. Use your own computer instead (Shell, Read, AwaitShell).";
export const SAND_LOCAL_TOOLS_UNAPPROVED_MESSAGE = `That action was not approved on the user's computer, so nothing ran. Ask the user to approve it (or to set Settings → Agent → Execution on Local Computer to "Always allow"), and use your own computer (Shell, Read, AwaitShell) in the meantime.`;
export const SAND_LOCAL_TOOLS_ABANDONED_MESSAGE = "The user was already asked about this exact action on their computer and did not approve it, so it will not run and will not be asked again for this task — a later permission change does not authorize it. Do not retry it. If it still needs to happen, say so in chat and let the user ask for it, and use your own computer in the meantime (Shell, Read, AwaitShell).";
export const SAND_LOCAL_TOOLS_STALE_TASK_MESSAGE = "This task's earlier requests to use the user's computer were not approved and the user has since moved on, so nothing from this task will run there. Do not retry. If it still needs to happen, say so in chat and let the user ask for it, and use your own computer in the meantime (Shell, Read, AwaitShell).";
export const SAND_LOCAL_TOOLS_PREPARATORY_MESSAGE = "That preparatory access to the user's computer was skipped: the user is asked about the action itself, not the work leading up to it. Continue without it.";
export const SAND_LOCAL_TOOLS_TARGET_TOO_LARGE_MESSAGE = "That action is too long to show the user for approval, so it was not run. Split it into smaller steps, or use your own computer instead (Shell, Read, AwaitShell).";

export interface SandLocalToolRequest {
  readonly action: SandLocalToolAction;
  readonly target: string;
  readonly resourcePath?: string;
  readonly attachToResourcePath?: string;
  readonly outlivesScope?: boolean;
  readonly signal?: AbortSignal;
  readonly description?: string;
}

export interface SandLocalToolApproval {
  readonly action: SandLocalToolAction;
  readonly target: string;
  readonly resourcePath?: string;
}

export interface SandLocalToolScope { readonly agentId: string; readonly toolCallId?: string; readonly action?: SandLocalToolAction; readonly directionEpoch?: number; }
export const sandLocalToolScopeKey: ContextKey<SandLocalToolScope | undefined> = createKey(
  Symbol("sand.local-tool.scope"),
  undefined,
);
export const sandTurnDirectionEpochKey: ContextKey<number | undefined> = createKey(
  Symbol("sand.local-tool.direction-epoch"),
  undefined,
);
export interface SandLocalToolGate {
  authorize(scope: SandLocalToolScope | undefined, request: SandLocalToolRequest): Promise<{ readonly allowed: boolean; readonly reason: string; readonly approvalId?: string }>;
}

export class SandLocalToolPermissionDeniedError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "SandLocalToolPermissionDeniedError"; }
}

export async function authorizeLocalToolAction(gate: SandLocalToolGate, scope: SandLocalToolScope | undefined, request: SandLocalToolRequest): Promise<string | undefined> {
  const decision = await gate.authorize(scope, request);
  if (!decision.allowed) throw new SandLocalToolPermissionDeniedError(decision.reason);
  return decision.approvalId;
}

function normalizeSeparators(path: string): string { return path.replace(/\\/g, "/").replace(/\/+$/, ""); }
function normalizeResourcePath(path: string | undefined): string | undefined { return path === undefined || path.length === 0 ? undefined : path.replace(/\\/g, "/"); }
export const normalizeLocalToolResourcePath = normalizeResourcePath;
export function sandTerminalFilePath(terminalsFolder: string, shellId: string): string | undefined { return shellId.length === 0 ? undefined : `${normalizeSeparators(terminalsFolder)}/${shellId}.txt`; }
export function isTerminalFile(path: string, terminalsFolder: string): boolean {
  const folder = normalizeSeparators(terminalsFolder); if (folder.length === 0) return false;
  const normalized = normalizeSeparators(path); if (!normalized.startsWith(`${folder}/`)) return false;
  const rest = normalized.slice(folder.length + 1); return rest.length > 0 && !rest.includes("/") && rest.endsWith(".txt");
}

export type LocalExecMessage = { readonly case?: string; readonly value: Record<string, unknown> };
export function describeLocalExec(serverMessage: { readonly message: LocalExecMessage }, terminalsFolder: string): SandLocalToolRequest | undefined {
  const message = serverMessage.message; const value = message.value;
  switch (message.case) {
    case "shellStreamArgs": case "backgroundShellSpawnArgs": {
      return { action: "run-command", target: value.command as string, resourcePath: terminalsFolder, ...((message.case === "backgroundShellSpawnArgs" || value.isBackground) ? { outlivesScope: true } : {}) };
    }
    case "forceBackgroundShellArgs": return { action: "run-command", target: "a command already running", attachToResourcePath: terminalsFolder, outlivesScope: true };
    case "writeShellStdinArgs": return { action: "send-input", target: value.chars as string };
    case "readArgs": case "redactedReadArgs": {
      const path = value.path as string;
      return { action: "read-file", target: path, ...(isTerminalFile(path, terminalsFolder) ? { attachToResourcePath: terminalsFolder } : {}) };
    }
    case "lsArgs": return { action: "list-directory", target: value.path as string };
    default: return undefined;
  }
}

export function localToolApprovalCovers(approval: SandLocalToolApproval, request: SandLocalToolRequest): boolean {
  if (approval.action === request.action && approval.target === request.target) return true;
  const owned = normalizeResourcePath(approval.resourcePath); const wanted = normalizeResourcePath(request.attachToResourcePath);
  return owned !== undefined && owned === wanted;
}
