import { z } from "zod";
import {
  SAND_CREATE_AGENT_TOOL_NAME,
  SAND_SEND_TO_AGENT_TOOL_NAME,
  SAND_UPDATE_AGENT_TOOL_NAME,
} from "../../agents/agent-messaging.js";
import { defineCommunicateTool } from "./communicate-tool.js";
import { isValidAttachmentUrl } from "./send-message-schema.js";
import type { Context } from "../../../packages/context/core.js";

export interface AgentImage {
  readonly url: string;
  readonly alt?: string;
}

export interface SendToAgentDependencies<_Context = Context> {
  getSelfAgentId(): string | undefined;
  resolveImageSource?(context: Context, url: string): Promise<string>;
  sendToAgent(
    targetId: string,
    message: string,
    images?: readonly AgentImage[],
    priority?: true,
  ): string | Promise<string>;
}

export interface AgentManagementDependencies {
  create(profile: { readonly name: string; readonly description: string }): Promise<{
    readonly id: string;
    readonly name: string;
  }>;
  update(
    agentId: string,
    patch: { readonly name?: string; readonly description?: string },
  ): Promise<{ readonly id: string; readonly name: string } | null>;
}

const imageSchema = z.object({
  url: z.string().trim().min(1).describe("file:// or https:// URL of the image."),
  alt: z.string().trim().optional().describe(
    "Optional short description of this image, shown on hover and as its fullscreen caption.",
  ),
});

export const sendToAgentParameters = z.object({
  target_id: z.string().trim().min(1).describe(
    "The id of the target — either another agent or a GROUP you belong to. Use an id from your teammates list, ListAgents, or ListGroups — not a name.",
  ),
  message: z.string().trim().min(1).describe(
    "What to say. Write it as if texting a teammate: lead with the point, keep it short.",
  ),
  images: z.array(imageSchema).optional().describe(
    "Optional image(s) to send with the message — a screenshot, chart, or photo the other agent needs. Delivered with your message: a 1:1 recipient actually sees them (like an image the user sends), and they render with your text in the exchange. Not delivered to groups.",
  ),
  priority: z.boolean().optional().describe(
    "When true (1:1 only; ignored for groups), interrupt the recipient's current non-user work and wake them immediately — same steer as a direct user message. Use for STOP / supersede / time-critical instructions. Default false: waits out the current turn, but still runs ahead of automations and other background work.",
  ),
}).superRefine((value, context) => {
  for (const [index, image] of (value.images ?? []).entries()) {
    if (!isValidAttachmentUrl(image.url)) {
      context.addIssue({
        code: "custom",
        path: ["images", index, "url"],
        message: "each images url must include a file:// or https:// scheme",
      });
    }
  }
});

export const createAgentParameters = z.object({
  name: z.string().trim().min(1).describe("A short, human-readable name for the new agent."),
  description: z.string().trim().default("").describe(
    "The new agent's persona / instructions: what it is for and how it should behave. This becomes its profile and shapes its replies. Optional but strongly recommended.",
  ),
});

export const updateAgentParameters = z.object({
  agent_id: z.string().trim().min(1).describe("The id of the agent to update."),
  name: z.string().trim().optional().describe("A new name for the agent. Omit to leave the name unchanged."),
  description: z.string().trim().optional().describe("A new persona/description for the agent. Omit to leave it unchanged."),
});

export async function resolveSendToAgentImages(
  context: Context,
  images: readonly z.infer<typeof imageSchema>[],
  resolveImageSource?: (context: Context, url: string) => Promise<string>,
): Promise<AgentImage[]> {
  const resolved: AgentImage[] = [];
  for (const image of images) {
    const url = resolveImageSource == null
      ? image.url
      : await resolveImageSource(context, image.url);
    const alt = image.alt != null && image.alt.length > 0 ? image.alt : undefined;
    resolved.push({ url, ...(alt == null ? {} : { alt }) });
  }
  return resolved;
}

export function createSendToAgentTool(
  dependencies: SendToAgentDependencies,
) {
  return defineCommunicateTool(dependencies, {
    id: "SEND_TO_TASK",
    name: SAND_SEND_TO_AGENT_TOOL_NAME,
    description: `Send a message to ANOTHER of your user's agents, OR post into a GROUP chat you belong to, by its id (not the user \u2014 SendMessage is how you reach the user). This is FIRE-AND-FORGET and asynchronous, like texting: it delivers your message, wakes that agent (or the group's members), and returns immediately with a delivery acknowledgement. Peer messages run ahead of automations and other background work; pass priority=true on a 1:1 send to interrupt the recipient's current non-user turn (STOP / supersede), like a direct user message (ignored for groups). It does NOT return their reply, and you must not wait or poll for one in this turn \u2014 send it and move on. Any reply arrives later as its own message that wakes you on a fresh turn. Get agent ids from your teammates list or ListAgents, and group ids from ListGroups. To include image(s) \u2014 a screenshot, chart, or photo the other agent needs \u2014 pass images: [{"url":"file:///absolute/path/to/shot.png","alt":"..."}] (file:// or https://). A 1:1 recipient actually sees them, like an image the user sends; never paste an image as a markdown ![](...) in the message text. Group posts are text-only today, so send images to an agent directly. Use it deliberately and sparingly \u2014 waking another agent or a whole group is a real side effect, so treat it like messaging on the user's behalf. Message someone or post to a group only when it truly serves the user's goal, not because one was mentioned or complained about, and don't spam a group. Never relay the user's private or unfiltered words (especially a complaint or criticism) verbatim; if relaying is warranted, paraphrase the actionable point diplomatically, not their tone. If you're unsure the user wants this sent, handle it yourself or ask first. Keep the message purposeful, professional, and minimal. One clearly relevant recipient can be normal work; messaging SEVERAL agents about the same effort (or posting it to a group) is a fan-out that wakes every recipient, and their replies land back in the user's chats and rooms \u2014 so fan out only when the user explicitly asked you to contact those agents. Otherwise propose it first with a question widget and wait for a yes, and never fan out "meanwhile" while you're waiting on the user for data or a decision.`,
    parameters: sendToAgentParameters,
    describeActivity: (args: z.infer<typeof sendToAgentParameters>) => ({
      target: args.target_id,
    }),
    async execute(context: Context, args: z.infer<typeof sendToAgentParameters>, resolved) {
      const self = resolved.getSelfAgentId();
      if (self != null && args.target_id === self) {
        return "You can't message yourself with SendToAgent. Use SendMessage to talk to the user, or pick a different target id.";
      }
      const images = await resolveSendToAgentImages(
        context,
        args.images ?? [],
        resolved.resolveImageSource,
      );
      return resolved.sendToAgent(
        args.target_id,
        args.message,
        images.length > 0 ? images : undefined,
        args.priority === true ? true : undefined,
      );
    },
  });
}

export function createCreateAgentTool(management: AgentManagementDependencies) {
  return defineCommunicateTool(management, {
    id: "CREATE_TASK",
    name: SAND_CREATE_AGENT_TOOL_NAME,
    description: `Create a new agent (a new teammate assistant) for your user, with a name and an optional persona/description. Returns the new agent's id so you can immediately message it with SendToAgent. Use this to spin up a focused teammate for a job. You have no tool to delete an agent, so only create one when it is genuinely useful; the user can delete an agent themselves from the sidebar (right-click the agent \u2192 "Delete").`,
    parameters: createAgentParameters,
    async execute(_context, args: z.infer<typeof createAgentParameters>, resolved) {
      const created = await resolved.create({
        name: args.name,
        description: args.description,
      });
      return `Created agent "${created.name}" (id: ${created.id}). Message it with SendToAgent using that id.`;
    },
  });
}

export function createUpdateAgentTool(management: AgentManagementDependencies) {
  return defineCommunicateTool(management, {
    id: "PLATFORM_ACTION",
    name: SAND_UPDATE_AGENT_TOOL_NAME,
    description: "Edit an existing agent's profile: its name and/or description. Only the fields you provide are changed; the rest are left exactly as they were, and there is no way to clear or delete an agent through this tool. Use it to refine a teammate you (or the user) created.",
    parameters: updateAgentParameters,
    describeActivity: (args: z.infer<typeof updateAgentParameters>) => ({
      target: args.agent_id,
    }),
    async execute(_context, args: z.infer<typeof updateAgentParameters>, resolved) {
      const patch: { name?: string; description?: string } = {};
      if (args.name != null && args.name.length > 0) patch.name = args.name;
      if (args.description != null && args.description.length > 0) {
        patch.description = args.description;
      }
      if (patch.name == null && patch.description == null) {
        return "Nothing to update: provide a new name and/or description.";
      }
      const updated = await resolved.update(args.agent_id, patch);
      return updated == null
        ? `No agent found with id ${args.agent_id}.`
        : `Updated agent "${updated.name}" (id: ${updated.id}).`;
    },
  });
}
