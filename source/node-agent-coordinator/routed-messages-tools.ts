import { randomUUID } from "node:crypto";

import {
  READ_MESSAGES_DESCRIPTION,
  READ_MESSAGES_INPUT_SCHEMA,
  SAND_READ_MESSAGES_TOOL_NAME,
  SAND_SEND_IMESSAGE_TOOL_NAME,
  SEND_IMESSAGE_DESCRIPTION,
  SEND_IMESSAGE_INPUT_SCHEMA,
  describeMessagesOp,
  messagesOpFromToolArgs,
  type MessagesOp,
} from "../shared/messages-request.js";
import type { SandLocalToolAction, SandLocalToolPermission } from "../shared/local-tool-permission.js";

/**
 * Messages for the routed providers (Codex, OpenRouter, Claude Code).
 *
 * The Cursor route reaches Messages through the host turn-toolset, which runs
 * on Cursor's remote box and relays to the desktop daemon. None of that exists
 * here: the coordinator is a local process on the same Mac, so it calls the
 * Messages code directly.
 *
 * What it must not skip is consent. The routed tool loop has no permission gate
 * of its own — the existing native tool writes files with no approval at all —
 * so reading someone's private conversations would otherwise be silent. This
 * asks with the same card the Cursor route uses, and keeps reading and sending
 * as separate approvals.
 */

export type RoutedToolResolution = "allow-once" | "allow-session" | "deny" | "always" | "never";

export interface RoutedNativeTool {
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly execute: (args: unknown) => Promise<string>;
}

export interface RoutedMessagesResult {
  readonly ok: boolean;
  readonly kind?: string;
  readonly transcript?: string;
  readonly count?: number;
  readonly to?: string;
  readonly error?: string;
}

export interface RoutedMessagesDeps {
  /** Appends or updates the approval card in the transcript the user is watching. */
  emitTranscript(agentId: string, type: "appended" | "updated", entry: Record<string, unknown>): void;
  getPermission(): SandLocalToolPermission;
  setPermission?(permission: SandLocalToolPermission): void;
  runMessagesOp(op: MessagesOp): Promise<RoutedMessagesResult>;
  nextEntryId?(agentId: string): string;
  now?(): number;
  randomId?(): string;
  /** An unanswered card must not hold a turn open forever. */
  askTimeoutMs?: number;
}

export const ROUTED_ASK_TIMEOUT_MS = 5 * 60_000;

interface PendingAsk {
  readonly agentId: string;
  readonly entryId: string;
  readonly action: SandLocalToolAction;
  readonly target: string;
  settle(resolution: RoutedToolResolution): void;
}

export function localToolPermissionCardEntry(args: {
  readonly entryId: string;
  readonly requestId: string;
  readonly action: SandLocalToolAction;
  readonly target: string;
  readonly status: "pending" | "allow-once" | "allow-session" | "always" | "denied" | "never" | "expired";
  readonly timestampMs: number;
}): Record<string, unknown> {
  return {
    kind: "send-message",
    id: args.entryId,
    message: {
      type: "local-tool-permission",
      ask: { requestId: args.requestId, status: args.status, action: args.action, target: args.target },
    },
    timestampMs: args.timestampMs,
  };
}

export function createRoutedMessagesTools(deps: RoutedMessagesDeps) {
  const pending = new Map<string, PendingAsk>();
  const now = deps.now ?? (() => Date.now());
  const randomId = deps.randomId ?? (() => randomUUID());
  const timeoutMs = deps.askTimeoutMs ?? ROUTED_ASK_TIMEOUT_MS;

  function refusal(action: SandLocalToolAction): string {
    return action === "send-imessage"
      ? "The user has not allowed sending iMessages from this app. They can change that in Settings, under Execution on Local Computer."
      : "The user has not allowed reading Messages from this app. They can change that in Settings, under Execution on Local Computer.";
  }

  async function requestApproval(agentId: string, action: SandLocalToolAction, target: string): Promise<RoutedToolResolution> {
    const permission = deps.getPermission();
    if (permission === "never") return "never";
    if (permission === "always") return "always";

    const requestId = randomId();
    const entryId = deps.nextEntryId?.(agentId) ?? `routed-ask-${requestId}`;
    const timestampMs = now();
    deps.emitTranscript(agentId, "appended", localToolPermissionCardEntry({ entryId, requestId, action, target, status: "pending", timestampMs }));

    const resolution = await new Promise<RoutedToolResolution>((resolve) => {
      let done = false;
      const finish = (value: RoutedToolResolution) => { if (done) return; done = true; pending.delete(requestId); clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => finish("deny"), timeoutMs);
      // Node keeps the process alive for a pending timer; an unanswered card
      // must not be a reason the app cannot exit.
      if (typeof timer.unref === "function") timer.unref();
      pending.set(requestId, { agentId, entryId, action, target, settle: finish });
    });

    if (resolution === "always" || resolution === "never") deps.setPermission?.(resolution);
    const settledStatus = resolution === "deny" ? "denied" : resolution;
    deps.emitTranscript(agentId, "updated", localToolPermissionCardEntry({ entryId, requestId, action, target, status: settledStatus, timestampMs }));
    return resolution;
  }

  async function run(agentId: string, toolName: string, args: unknown): Promise<string> {
    const op = messagesOpFromToolArgs(toolName, args, now());
    if (op === undefined) {
      return toolName === SAND_SEND_IMESSAGE_TOOL_NAME
        ? "A recipient and a message body are both required."
        : "Those arguments could not be read as a Messages request.";
    }
    const described = describeMessagesOp(op);
    if (described === undefined) return "That Messages request was malformed.";

    const resolution = await requestApproval(agentId, described.action, described.target);
    if (resolution === "deny" || resolution === "never") return refusal(described.action);

    const result = await deps.runMessagesOp(op);
    if (!result.ok) return result.error ?? "Reading Messages failed.";
    if (result.kind === "send") return `Sent to ${result.to ?? (op.op === "send" ? op.to : "")}.`;
    const count = typeof result.count === "number" ? result.count : 0;
    const transcript = typeof result.transcript === "string" ? result.transcript : "No messages matched.";
    return count === 0 ? transcript : `${count} message${count === 1 ? "" : "s"}:\n${transcript}`;
  }

  return {
    /** The tools as the routed loop wants them, with execute bound to this agent. */
    tools(agentId: string): readonly RoutedNativeTool[] {
      return [
        {
          name: SAND_READ_MESSAGES_TOOL_NAME,
          providerIdentifier: "grok-bot",
          toolName: SAND_READ_MESSAGES_TOOL_NAME,
          description: READ_MESSAGES_DESCRIPTION,
          inputSchema: READ_MESSAGES_INPUT_SCHEMA,
          execute: async (args: unknown) => await run(agentId, SAND_READ_MESSAGES_TOOL_NAME, args),
        },
        {
          name: SAND_SEND_IMESSAGE_TOOL_NAME,
          providerIdentifier: "grok-bot",
          toolName: SAND_SEND_IMESSAGE_TOOL_NAME,
          description: SEND_IMESSAGE_DESCRIPTION,
          inputSchema: SEND_IMESSAGE_INPUT_SCHEMA,
          execute: async (args: unknown) => await run(agentId, SAND_SEND_IMESSAGE_TOOL_NAME, args),
        },
      ];
    },

    /**
     * Answers an approval card. Returns false for anything this coordinator did
     * not ask, so host-owned asks keep falling through to the gateway untouched.
     */
    resolveAsk(args: unknown): boolean {
      const record = (typeof args === "object" && args != null ? args : {}) as Record<string, unknown>;
      const requestId = typeof record.requestId === "string" ? record.requestId : "";
      const entry = pending.get(requestId);
      if (entry === undefined) return false;
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      if (agentId.length > 0 && agentId !== entry.agentId) return false;
      const resolution = record.resolution;
      if (resolution !== "allow-once" && resolution !== "allow-session" && resolution !== "deny" && resolution !== "always" && resolution !== "never") return false;
      entry.settle(resolution);
      return true;
    },

    hasPendingAsk(requestId: string): boolean { return pending.has(requestId); },
  };
}
