import type { SandLocalToolRequest } from "./local-tool-permission-machinery.js";

/**
 * The Messages request contract, shared by the box side that asks and the
 * desktop daemon that answers. Kept free of Node imports so both can hold it:
 * the execution lives in `host/local-exec/messages-op.ts`, which is Mac-only.
 */
export type MessagesOp =
  | { readonly op: "read"; readonly contact?: string; readonly limit?: number; readonly sinceMs?: number }
  | { readonly op: "send"; readonly to: string; readonly body: string };

export function isMessagesOp(value: unknown): value is MessagesOp {
  if (typeof value !== "object" || value == null) return false;
  const record = value as Record<string, unknown>;
  if (record.op === "read") {
    return (record.contact === undefined || typeof record.contact === "string")
      && (record.limit === undefined || typeof record.limit === "number")
      && (record.sinceMs === undefined || typeof record.sinceMs === "number");
  }
  return record.op === "send" && typeof record.to === "string" && typeof record.body === "string";
}

/**
 * What the consent prompt says this request will do. Reading someone's message
 * history and sending as them are different enough that they are separate
 * actions with separate approvals — agreeing to one must never imply the other.
 * The target is what the person is really deciding about: whose conversation,
 * or which recipient.
 */
export function describeMessagesOp(op: unknown): SandLocalToolRequest | undefined {
  if (!isMessagesOp(op)) return undefined;
  if (op.op === "send") return { action: "send-imessage", target: op.to };
  const contact = op.contact?.trim();
  return {
    action: "read-messages",
    target: contact != null && contact.length > 0 ? contact : "all recent conversations",
  };
}

export const SAND_READ_MESSAGES_TOOL_NAME = "ReadMessages";
export const SAND_SEND_IMESSAGE_TOOL_NAME = "SendIMessage";

/**
 * The model-facing contract, kept here because two separate runtimes present
 * these tools: the host turn-toolset (Cursor route) and the coordinator's
 * routed toolset (Codex, OpenRouter, Claude Code). Describing them twice would
 * let the two drift, and the description is the only thing telling the model
 * how carefully to treat someone's private correspondence.
 */
export const READ_MESSAGES_DESCRIPTION =
  "Read the user's iMessage/SMS conversations from the Messages app on their Mac. Use it when the user asks what "
  + "someone said, to catch up on a thread, or to find something in their messages. This is the user's private "
  + "correspondence: read only the conversation you were asked about, take the smallest number of messages that "
  + "answers the question, and never go looking through other threads on your own initiative. It needs the user's "
  + "permission each time unless they have granted it standing, and it needs macOS Full Disk Access — if that is "
  + "missing the tool says so and what to do about it.";

export const SEND_IMESSAGE_DESCRIPTION =
  "Send an iMessage from the user's own account on their Mac. It goes out as them, to a real person, and cannot be "
  + "unsent — so send only a message the user has actually asked you to send, with the wording they approved, and "
  + "never send one to check whether the tool works. Confirm the recipient with them if there is any doubt about "
  + "which number or address is right. It needs the user's permission each time unless they have granted it "
  + "standing, and it needs macOS Automation access for Messages.";

// `required` is spelled out even when empty: some providers reject a function
// schema that sets additionalProperties:false without it, and the failure shows
// up as the whole turn returning no text rather than as a tool error.
export const READ_MESSAGES_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [] as readonly string[],
  properties: {
    contact: { type: "string", description: "Whose conversation to read: a phone number, an Apple ID email, or part of a group's name. Omit to read the most recent messages across every conversation — prefer naming someone, since omitting this reads everything." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "How many messages to return, newest first, before they are shown oldest-first. Defaults to 25." },
    since_hours: { type: "number", minimum: 0.1, maximum: 8_760, description: "Only return messages from the last N hours. Omit for no time limit." },
  },
} as const;

export const SEND_IMESSAGE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["to", "body"],
  properties: {
    to: { type: "string", description: "The recipient: a phone number in +country format (e.g. +15551234567) or the Apple ID email they use for iMessage. This must be exact — Messages cannot resolve a first name." },
    body: { type: "string", maxLength: 4_000, description: "The message text to send, exactly as it should appear." },
  },
} as const;

const HOURS_IN_MS = 3_600_000;

/** Turns model-supplied tool arguments into a MessagesOp, or undefined if unusable. */
export function messagesOpFromToolArgs(toolName: string, args: unknown, now: number): MessagesOp | undefined {
  const record = (typeof args === "object" && args != null ? args : {}) as Record<string, unknown>;
  if (toolName === SAND_SEND_IMESSAGE_TOOL_NAME) {
    const to = typeof record.to === "string" ? record.to.trim() : "";
    const body = typeof record.body === "string" ? record.body.trim() : "";
    return to.length > 0 && body.length > 0 ? { op: "send", to, body } : undefined;
  }
  if (toolName !== SAND_READ_MESSAGES_TOOL_NAME) return undefined;
  const contact = typeof record.contact === "string" && record.contact.trim().length > 0 ? record.contact.trim() : undefined;
  const limit = typeof record.limit === "number" && Number.isFinite(record.limit) ? record.limit : undefined;
  const sinceHours = typeof record.since_hours === "number" && Number.isFinite(record.since_hours) ? record.since_hours : undefined;
  return {
    op: "read",
    ...(contact === undefined ? {} : { contact }),
    ...(limit === undefined ? {} : { limit }),
    ...(sinceHours === undefined ? {} : { sinceMs: now - sinceHours * HOURS_IN_MS }),
  };
}
