import { z } from "zod";
import { sandWidgetSchema } from "../../../shared/sand-widgets.js";
export const SEND_MESSAGE_TYPES = ["text", "attachment", "widget", "cursor-agent", "secret-request"] as const;
export const SEND_MESSAGE_TYPE_DESCRIPTION = "text for chat messages, attachment for actual files or standalone media, widget for an interactive question with selectable options, cursor-agent to reference a Cursor cloud agent by its bcId (renders as a card that opens the agent in Cursor on click), secret-request to ask the user for a credential through a secure masked input (never a chat paste).";
export type SendMessageType = typeof SEND_MESSAGE_TYPES[number];
export interface SendMessageInput {
  readonly type: SendMessageType; readonly content?: string | undefined; readonly url?: string | undefined;
  readonly images?: readonly { readonly url: string; readonly alt?: string | undefined }[] | undefined; readonly alt?: string | undefined;
  readonly reply_to?: string | undefined; readonly channel?: string | undefined; readonly widget?: unknown; readonly bcId?: string | undefined;
  readonly secret?: { readonly label: string; readonly description?: string | undefined; readonly connector: string; readonly field: string } | undefined;
}
export interface SendMessageIssue { readonly path: readonly (string | number)[]; readonly message: string }
export function isValidAttachmentUrl(value: string): boolean { try { return ["file:", "https:"].includes(new URL(value).protocol); } catch { return false; } }
export function isFieldProvided(value: unknown): boolean { return value != null && (typeof value !== "string" || value.length > 0) && (!Array.isArray(value) || value.length > 0); }
const TYPE_FIELDS: readonly { field: keyof SendMessageInput; types: readonly SendMessageType[] }[] = [
  { field: "content", types: ["text"] }, { field: "url", types: ["attachment"] }, { field: "alt", types: ["attachment"] },
  { field: "widget", types: ["widget"] }, { field: "bcId", types: ["cursor-agent"] }, { field: "secret", types: ["secret-request"] },
];
export function refineSendMessage(value: SendMessageInput): SendMessageIssue[] {
  const issues: SendMessageIssue[] = [];
  for (const { field, types } of TYPE_FIELDS) if (!types.includes(value.type) && isFieldProvided(value[field])) { const allowed = types.map((type) => `type:${type}`).join(" or "); issues.push({ path: [String(field)], message: `${String(field)} is only valid with ${allowed} and cannot ride a type:${value.type} message \u2014 it would be silently dropped. Nothing was sent. Re-send as separate SendMessage calls, one per type: this field on its own properly-typed message (${allowed}), and any text as its own type:text message.` }); }
  if (value.channel && value.type !== "text" && value.type !== "attachment") issues.push({ path: ["channel"], message: "channel can only be set for type:text or type:attachment, not widgets or cursor-agent cards" });
  if ((value.images?.length ?? 0) > 0 && value.type !== "text") issues.push({ path: ["images"], message: "images can only be set for type:text (they attach to a text message); for a standalone attachment use type:attachment with url" });
  if (value.type === "text") {
    if (!value.content) issues.push({ path: ["content"], message: "content is required when type is text" });
    for (const [index, image] of (value.images ?? []).entries()) if (!isValidAttachmentUrl(image.url)) issues.push({ path: ["images", index, "url"], message: "each images url must include a file:// or https:// scheme" });
  } else if (value.type === "attachment") {
    if (!value.url) issues.push({ path: ["url"], message: "url is required when type is attachment" });
    else if (!isValidAttachmentUrl(value.url)) issues.push({ path: ["url"], message: "url must include a file:// or https:// scheme when type is attachment" });
  }
  return issues;
}
const objectSchema = z.object({
  type: z.enum(SEND_MESSAGE_TYPES).describe(SEND_MESSAGE_TYPE_DESCRIPTION),
  content: z.string().trim().optional().describe("Required when type is text. The message to show to the user."),
  url: z.string().trim().optional().describe("Required when type is attachment. Use file:// for local files or https:// for remote files and standalone media."),
  images: z.array(z.object({
    url: z.string().trim().min(1).describe("file:// or https:// URL of the image."),
    alt: z.string().trim().optional().describe("Optional short description of this image, shown on hover and as its fullscreen caption."),
  })).optional().describe("Optional, only for type:text. Image(s) that belong with this message; they render inside the same chat bubble, below your text \u2014 one image full width, several as a compact gallery. Use whenever you're showing something you're talking about; use type:attachment only for an image that IS the whole message."),
  alt: z.string().trim().optional().describe("Optional. A short description (alt text) of the image for type:attachment \u2014 what the image shows. Shown to the user on hover and in the fullscreen viewer."),
  reply_to: z.string().trim().optional().describe("Optional. Short address of the prior message this reply threads to (e.g. t3u for the user message in turn 3, t3s1 for your second SendMessage in turn 3). Omit when not threading."),
  channel: z.string().trim().optional().describe("Optional. A connected messaging channel address to deliver this to instead of the in-app Grok Bot chat, shaped platform:chat, the address shown to you in an [inbound] wake. Omit to send to the in-app chat (the default). Only valid with type:text or type:attachment."),
  widget: sandWidgetSchema.optional().describe("Required when type is widget. A question with selectable options: { prompt, helpText?, options: [{ label, value?, description?, style? }], allowCustom?, dismissOnMoveOn? }. The user picks one option; its value comes back as their reply, and the chat shows the resolved card with their selection checked under your prompt \u2014 so phrase the prompt as a natural question, not a menu instruction. The user can also dismiss the question without answering; you'll be told on your next turn, so treat that as a decline and don't re-ask. Set allowCustom: true to also let the user type their own free-text answer instead of picking an option. Set dismissOnMoveOn: true only for low-stakes questions that become moot if the user moves on (it auto-dismisses once they send a newer message without answering); leave it off for real decisions you still need answered."),
  bcId: z.string().trim().optional().describe("Required when type is cursor-agent. The bcId of the Cursor cloud agent to reference (e.g. bc-xxxxxxxx-...)."),
  secret: z.object({
    label: z.string().trim().min(1).describe('What credential to ask for, shown as the card title and echoed in the field placeholder ("Paste your \u2026"), e.g. "Slack bot token".'),
    description: z.string().trim().optional().describe("Optional short help shown under the label."),
    connector: z.string().trim().min(1).describe("The connector/platform the secret is for. The value is written to that connector's per-agent credential file."),
    field: z.string().trim().min(1).describe('The credential field name to store the value under, e.g. "token".'),
  }).optional().describe("Required when type is secret-request. Asks the user for a credential through a masked secure input; the value goes straight to the connector's credential file and never reaches you or the chat. You only learn that it was provided."),
});
export const sendMessageParameters = objectSchema.superRefine((value, ctx) => { for (const issue of refineSendMessage(value)) ctx.addIssue({ code: "custom", path: [...issue.path], message: issue.message }); });
