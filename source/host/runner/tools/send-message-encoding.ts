import path from "node:path";
import { ToolCall } from "../../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  SendMessageArgs,
  SendMessageAttachment,
  SendMessageText,
  type SendMessageToolCall,
} from "../../../packages/proto/generated/agent/v1/send_message_tool_pb.js";
import { isBoxRootPath } from "../../box/box-transfer.js";
import { imageMimeFromPath } from "../../../shared/media/image-mime.js";
import { summarizeWidget } from "../../../shared/sand-widgets.js";
import { summarizePermissionRequest } from "./sand-permission-request.js";
import { summarizeSecretRequest } from "./sand-secret-request.js";
export type EncodableMessage = Readonly<Record<string, unknown>> & { readonly type: string };
export function createSendMessageToolCall(toolCall: SendMessageToolCall): ToolCall {
  return new ToolCall({ tool: { case: "sendMessageToolCall", value: toolCall } });
}
function text(content: string): SendMessageArgs {
  return new SendMessageArgs({ message: { case: "text", value: new SendMessageText({ content }) } });
}
export function encodeMarkdownImageDestination(url: string): string { return `<${url.replace(/[<>\r\n]/g, encodeURIComponent)}>`; }
export function encodeTextContent(message: { readonly content: string; readonly images?: readonly { readonly url: string; readonly alt?: string }[] }): string {
  if ((message.images?.length ?? 0) === 0) return message.content;
  const markdown = message.images!.map((image) => `![${(image.alt ?? "").replace(/[[\]\n]/g, " ").trim()}](${encodeMarkdownImageDestination(image.url)})`).join("\n");
  return `${message.content}\n\n${markdown}`;
}
export function encodeSendMessage(message: EncodableMessage): SendMessageArgs {
  switch (message.type) {
    case "text": return text(encodeTextContent({ content: String(message.content ?? ""), ...(Array.isArray(message.images) ? { images: message.images as readonly { url: string; alt?: string }[] } : {}) }));
    case "attachment": return new SendMessageArgs({ message: { case: "attachment", value: new SendMessageAttachment({ url: String(message.url ?? ""), ...(typeof message.alt === "string" ? { alt: message.alt } : {}) }) } });
    case "widget": return text(summarizeWidget(message.widget as { prompt?: unknown; options?: unknown }));
    case "cursor-agent": { const title = typeof message.title === "string" ? message.title.trim() : ""; const bcId = String(message.bcId ?? ""); return text(title.length > 0 ? `Referenced Cursor cloud agent ${bcId} (${title})` : `Referenced Cursor cloud agent ${bcId}`); }
    case "secret-request": return text(summarizeSecretRequest((message.secretRequest ?? message.secret) as { label: string }));
    case "permission-request": return text(summarizePermissionRequest(message.permission as { title: string; reason: string }));
    case "auto-review-approval": { const approval = message.approval as Record<string, unknown>; return text(`Auto-review requested approval for: ${String(approval.summary)}. Status: ${String(approval.status)}.`); }
    case "local-tool-permission": { const ask = message.ask as Record<string, unknown>; return text(`Asked the user for permission to use their computer (${String(ask.action)}: ${String(ask.target)}). Status: ${String(ask.status)}.`); }
    case "connector": return text(message.variant === "connected" ? `Confirmed the ${String(message.connector)} connector is connected` : `Asked the user to connect the ${String(message.connector)} connector`);
    case "connectors": return text(`Asked the user to connect: ${(message.connectors as readonly string[]).join(", ")}`);
    case "listener-connect": return text(`Asked the user to connect ${message.platform === "slack" ? "Slack" : "GitHub"} for listener routines`);
    case "email-draft": {
      const draft = message.draft as { from?: string; to: readonly string[]; cc?: readonly string[]; subject: string; body: string };
      const cc = draft.cc?.join(", ");
      return text(`Draft email${draft.from == null ? "" : `\nFrom: ${draft.from}`}\nTo: ${draft.to.join(", ")}${cc == null ? "" : `\nCc: ${cc}`}\nSubject: ${draft.subject}\n\n${draft.body}`);
    }
    case "slack-draft": {
      const draft = message.draft as { workspace?: string; target: string; thread?: string; body: string };
      return text(`Draft Slack message${draft.workspace == null ? "" : ` in ${draft.workspace}`} to ${draft.target}\nThread: ${draft.thread ?? "New message"}\n\n${draft.body}`);
    }
    default: throw new Error(`Unsupported send-message type: ${message.type}`);
  }
}
export async function resolveBoxMediaAttachment(request: { readonly boxPath: string; readonly remoteBoxHasDesktop: boolean; readonly download: (path: string) => Promise<Uint8Array | null>; readonly persistImage?: (bytes: Uint8Array, mime: string) => Promise<{ fileUrl: string } | null>; readonly persistMediaBytes?: (name: string, bytes: Uint8Array) => Promise<string | null> }): Promise<string | null> {
  if (!request.remoteBoxHasDesktop || !isBoxRootPath(request.boxPath)) return null;
  try { const data = await request.download(request.boxPath); if (data == null) return null; const mime = imageMimeFromPath(request.boxPath); if (mime != null) return (await request.persistImage?.(data, mime))?.fileUrl ?? null; return await request.persistMediaBytes?.(path.basename(request.boxPath), data) ?? null; } catch { return null; }
}
