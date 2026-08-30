import { z } from "zod";
import { defineCommunicateTool } from "./communicate-tool.js";
import {
  READ_MESSAGES_DESCRIPTION,
  SAND_READ_MESSAGES_TOOL_NAME,
  SAND_SEND_IMESSAGE_TOOL_NAME,
  SEND_IMESSAGE_DESCRIPTION,
  type MessagesOp,
} from "../../../shared/messages-request.js";
import type { Context } from "../../../packages/context/core.js";

// Names and model-facing prose live in shared/messages-request.ts: the routed
// coordinator presents the same two tools, and describing them twice would let
// the descriptions drift apart.
export { SAND_READ_MESSAGES_TOOL_NAME, SAND_SEND_IMESSAGE_TOOL_NAME };

export const readMessagesParameters = z.object({
  contact: z.string().trim().min(1).optional().describe(
    "Whose conversation to read: a phone number, an Apple ID email, or part of a group's name. Omit to read the most recent messages across every conversation — prefer naming someone, since omitting this reads everything.",
  ),
  limit: z.number().int().min(1).max(200).optional().describe(
    "How many messages to return, newest first, before they are shown oldest-first. Defaults to 25.",
  ),
  since_hours: z.number().min(0.1).max(8_760).optional().describe(
    "Only return messages from the last N hours. Omit for no time limit.",
  ),
});

export const sendIMessageParameters = z.object({
  to: z.string().trim().min(1).describe(
    "The recipient: a phone number in +country format (e.g. +15551234567) or the Apple ID email they use for iMessage. This must be exact — Messages cannot resolve a first name.",
  ),
  body: z.string().trim().min(1).max(4_000).describe(
    "The message text to send, exactly as it should appear.",
  ),
});

export interface MessagesToolDependencies {
  messagesOp(context: Context, op: MessagesOp): Promise<Record<string, unknown>>;
}

const HOURS_IN_MS = 3_600_000;

export function createReadMessagesTool<Dependencies extends MessagesToolDependencies>(dependencies: Dependencies) {
  return defineCommunicateTool(dependencies, {
    id: "READ_MESSAGES",
    name: SAND_READ_MESSAGES_TOOL_NAME,
    description: READ_MESSAGES_DESCRIPTION,
    parameters: readMessagesParameters,
    async execute(context: Context, args: z.infer<typeof readMessagesParameters>, resolved) {
      const op: MessagesOp = {
        op: "read",
        ...(args.contact === undefined ? {} : { contact: args.contact }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.since_hours === undefined ? {} : { sinceMs: Date.now() - args.since_hours * HOURS_IN_MS }),
      };
      const result = await resolved.messagesOp(context, op);
      const count = typeof result.count === "number" ? result.count : 0;
      const transcript = typeof result.transcript === "string" ? result.transcript : "No messages matched.";
      return count === 0 ? transcript : `${count} message${count === 1 ? "" : "s"}:\n${transcript}`;
    },
  });
}

export function createSendIMessageTool<Dependencies extends MessagesToolDependencies>(dependencies: Dependencies) {
  return defineCommunicateTool(dependencies, {
    id: "SEND_IMESSAGE",
    name: SAND_SEND_IMESSAGE_TOOL_NAME,
    description: SEND_IMESSAGE_DESCRIPTION,
    parameters: sendIMessageParameters,
    async execute(context: Context, args: z.infer<typeof sendIMessageParameters>, resolved) {
      await resolved.messagesOp(context, { op: "send", to: args.to, body: args.body });
      return `Sent to ${args.to}.`;
    },
  });
}
