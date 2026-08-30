import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SendMessageError,
  SendMessageResult,
  SendMessageSuccess,
  SendMessageToolCall,
} from "../../../packages/proto/generated/agent/v1/send_message_tool_pb.js";
import type { Context } from "../../../packages/context/core.js";
import { createStringResult } from "../../../packages/chat-inference/prompt-executor.js";
import { createZodAgentTool, withSafeParsedArgs } from "../../../packages/agent/tools/common.js";
import { createSendMessageToolCall, encodeSendMessage } from "./send-message-encoding.js";
import { sendMessageParameters, type SendMessageInput } from "./send-message-schema.js";
import { clampSecretDescription, clampSecretLabel } from "./sand-secret-request.js";
import { SandToolInputError } from "./tool-input-error.js";
export const SAND_SEND_MESSAGE_TOOL_NAME = "SendMessage";
const SAND_SEND_MESSAGE_TOOL_DESCRIPTION = `Say something to the user in the Grok Bot chat. This is your only voice. The user only ever sees the content of SendMessage calls; your plain assistant text is invisible to them (it is just your private scratchpad), so a reply counts only once it is inside SendMessage, including short, casual, or social replies like "Hey" or "Doing good, you?". Finish a turn where someone is waiting on you without calling SendMessage and they see total silence and assume you ignored them; the lone exception is a scheduled routine (a [routine] run) whose saved instruction says to stay quiet when there's nothing to report, where ending with no SendMessage is correct rather than filler like "(no change.)". Keep the user posted with meaningful beats, not just at the end: post an update for a real result, decision, blocker, or change of plan, and batch or omit routine mechanics, retries, and minor snags rather than narrating each one; prefer fewer, higher-signal updates over a play-by-play. Still, never vanish into a long silent run on something the user is waiting on. This also covers results: output the user is waiting on counts as delivered only inside a SendMessage, so an opening acknowledgement does not discharge it (ack \u2260 delivery), and if you ran something for them you send the actual result before you yield. Use {"type":"text","content":"..."} for normal messages. In text content you can point back at a specific earlier message with a reference link: [label](sand-msg:<address>), e.g. "Covered in [my earlier breakdown](sand-msg:t2s1)" \u2014 it renders as a small chip that jumps there on click. Addresses are the same ones reply_to uses (a user message's [t3u] tag, the id a sent message hands back), but unlike reply_to this never threads anything. Reference only where pointing back genuinely helps (an "as I mentioned earlier" moment); write the label as the words your sentence needs, and never write a bare address into visible text. Use {"type":"attachment","url":"file:///absolute/path/to/file.png"} for actual files or standalone media; https:// file/media URLs are also accepted. The rule for images: if image(s) belong WITH what you're saying, attach them to the text message itself \u2014 {"type":"text","content":"...","images":[{"url":"file:///absolute/path/to/shot.png","alt":"..."}]} renders them inside the same chat bubble, below your text (one image full width, several as a compact gallery). Use {"type":"attachment"} only when the image IS the whole message, with no accompanying text; videos and non-image files always go as attachments. Never embed images as markdown ![](...) in content. Use {"type":"cursor-agent","bcId":"bc-..."} to reference a Cursor cloud agent: it renders as a card the user can click to open that agent in Cursor. Always use this instead of pasting a cloud agent's URL or bcId as text. In your own text call it a "cloud agent" or by its name; "card" is only how this attachment renders, never a word you write to the user (no "(card)" label). Use {"type":"widget","widget":{...}} to ask the user a question with selectable options instead of asking in plain text \u2014 but ask rarely: by default decide and proceed (see Autonomy), reserving a widget for a consequential or destructive go/no-go, true ambiguity you cannot resolve by looking it up, or something only the user knows. Every option must be a real, verified choice, never invented, guessed, or a plausible-looking placeholder; if you do not know the real options, look them up first (search the relevant connector, tool, or directory) rather than presenting fakes. Use {"type":"secret-request","secret":{"label":"...","connector":"...","field":"..."}} to ask for a credential (an API token, key, or secret): the user gets a masked secure input and the value goes straight to the connector's credential file. NEVER ask the user to paste a token, key, or password into the chat; always request it this way so it stays out of the transcript and out of your context. You only learn that they provided it. Sending a secret-request ends your turn; you are resumed once they submit. When a task needs access the operating system gates behind a consent dialog (reading a protected folder like Documents/Desktop/Downloads, screen recording, the microphone, the camera, ...), just attempt the action directly \u2014 the OS surfaces its own permission dialog naturally when it is required, and the user grants there. Do NOT announce it first, invent a permission card or click-path, or promise that "your system will ask" \u2014 attempt the action and let the real dialog appear. (For a manual desktop step only the user can do \u2014 a login, SSO, 2FA, captcha, or payment \u2014 use request_box_help instead.) The widget has a prompt, optional helpText, and 1-6 options; each option has a label, an optional value (the text sent back to you when confirmed; defaults to the label), an optional description, and an optional style ("default"|"primary"|"danger"). Set the optional allowCustom: true to also let the user type their own free-text answer instead of picking an option. Set the optional dismissOnMoveOn: true only for low-stakes questions that become moot if the user moves on; the widget then auto-dismisses once they send a newer message without answering. Leave it off (default) for real decisions you still need answered. The user picks an option and its value comes back to you as their reply. In the chat, the resolved card keeps your question and shows their selection checked under it, so phrase the prompt as a natural conversational question (never a menu instruction like "Pick one of the following") and give every option a value that reads like a reply the user would actually send. The user can also dismiss the question without answering; you'll be told on your next turn \u2014 treat that as a decline and don't re-ask. Example: {"type":"widget","widget":{"prompt":"Deploy to production?","options":[{"label":"Deploy","value":"Yes, deploy now","style":"primary"},{"label":"Cancel","value":"No, hold off","style":"danger"}]}}. When you do genuinely need a decision or confirmation, this widget is how you ask, not plain text. Sending a widget ends your turn; make it your last action and stop, and the user's selection arrives as the next message.`;
export const SAND_AWAITING_USER_SEND_MESSAGE_BLOCKED = "This turn is already waiting on the user (you sent a question widget or handed the box back to them), so this message was not delivered. Wait for the user — their response arrives as the next message — then say this on your next turn.";
export interface SandOutgoingMessage extends Record<string, unknown> { readonly type: SendMessageInput["type"]; }
export interface SendMessageDependencies<Context> {
  readonly isAwaitingUserSelection?: () => boolean;
  readonly resolveCloudAgentTitle?: (ctx: Context, bcId: string) => Promise<string | undefined>;
  readonly getIngestAttachment: () => ((sourcePath: string) => Promise<string>) | undefined;
  readonly resolveBoxAttachment?: (ctx: Context, sourcePath: string) => Promise<string | null>;
  readonly readMediaDimensions?: (sourcePath: string) => Promise<{ width: number; height: number } | null>;
  readonly classifyAttachment?: (url: string) => "file" | "media";
  readonly onSendMessage: (message: SandOutgoingMessage, timestampMs: number) => string | undefined;
}
function filePathFromFileUrl(url: string): string | null { try { return new URL(url).protocol === "file:" ? fileURLToPath(url) : null; } catch { return null; } }
export async function resolveAttachmentSource<Context>(ctx: Context, sourceUrl: string, deps: SendMessageDependencies<Context>): Promise<{ url: string; fileName?: string }> {
  const sourcePath = filePathFromFileUrl(sourceUrl), fileName = sourcePath == null ? undefined : path.basename(sourcePath);
  const result = (url: string) => ({ url, ...(fileName == null || fileName.length === 0 ? {} : { fileName }) });
  if (sourcePath == null) return result(sourceUrl);
  const ingest = deps.getIngestAttachment();
  if (ingest != null) try { return result(pathToFileURL(await ingest(sourcePath)).href); } catch {}
  return result(await deps.resolveBoxAttachment?.(ctx, sourcePath) ?? sourceUrl);
}
async function dimensions<Context>(url: string, deps: SendMessageDependencies<Context>): Promise<{ width: number; height: number } | undefined> { const file = filePathFromFileUrl(url); return file == null ? undefined : await deps.readMediaDimensions?.(file) ?? undefined; }
export async function buildSandSendMessage<Context>(ctx: Context, input: SendMessageInput, deps: SendMessageDependencies<Context>): Promise<SandOutgoingMessage> {
  const raw = sendMessageParameters.parse(input); const reply = raw.reply_to || undefined, channel = raw.channel || undefined;
  if (raw.type === "text") { const images = []; for (const image of raw.images ?? []) { const source = await resolveAttachmentSource(ctx, image.url, deps); images.push({ url: source.url, ...(image.alt ? { alt: image.alt } : {}), ...await dimensions(source.url, deps) }); } return { type: "text", content: raw.content ?? "", ...(images.length ? { images } : {}), ...(reply ? { reply_to: reply } : {}), ...(channel ? { channel } : {}) }; }
  if (raw.type === "widget") { if (raw.widget == null) throw new SandToolInputError("widget is required when type is widget"); return { type: "widget", widget: raw.widget, ...(reply ? { reply_to: reply } : {}) }; }
  if (raw.type === "cursor-agent") { if (!raw.bcId) throw new SandToolInputError("bcId is required when type is cursor-agent"); let title: string | undefined; try { title = (await deps.resolveCloudAgentTitle?.(ctx, raw.bcId))?.trim() || undefined; } catch {} return { type: "cursor-agent", bcId: raw.bcId, ...(title ? { title } : {}), ...(reply ? { reply_to: reply } : {}) }; }
  if (raw.type === "secret-request") { const secret = raw.secret; if (secret == null) throw new SandToolInputError("secret is required when type is secret-request"); return { type: "secret-request", secretRequest: { label: clampSecretLabel(secret.label), ...(secret.description ? { description: clampSecretDescription(secret.description) } : {}), target: { kind: "channel-credential", platform: secret.connector, field: secret.field } }, ...(reply ? { reply_to: reply } : {}) }; }
  const url = raw.url ?? "";
  try { if (new URL(url).protocol === "https:" && deps.classifyAttachment?.(url) === "file") return { type: "text", content: url, ...(reply ? { reply_to: reply } : {}), ...(channel ? { channel } : {}) }; } catch {}
  const source = await resolveAttachmentSource(ctx, url, deps);
  return { type: "attachment", url: source.url, ...(reply ? { reply_to: reply } : {}), ...(source.fileName ? { file_name: source.fileName } : {}), ...(raw.alt ? { alt: raw.alt } : {}), ...(channel ? { channel } : {}), ...await dimensions(source.url, deps) };
}
export interface SendMessageInteractionHandler<Context> {
  emitPartialToolCall(context: Context, toolCallId: string, toolCall: unknown): void;
  executeToolCall<Result>(
    context: Context,
    initial: unknown,
    toolCallId: string,
    execute: (context: Context) => Promise<Result>,
    complete: (result: Result) => unknown,
  ): Promise<Result>;
}

function errorResult(error: string): SendMessageResult {
  return new SendMessageResult({
    result: { case: "error", value: new SendMessageError({ error }) },
  });
}

export function createSendMessageTool(deps: SendMessageDependencies<Context>) {
  const execute = async (
    ctx: Context,
    interactionHandler: SendMessageInteractionHandler<Context>,
    input: SendMessageInput,
    meta: { readonly toolCallId: string },
  ): Promise<SendMessageResult> => {
    const message = await buildSandSendMessage(ctx, input, deps);
    const encodedArgs = encodeSendMessage(message);
    const baseToolCall = new SendMessageToolCall({ args: encodedArgs });
    const run = async (): Promise<SendMessageResult> => {
      if (deps.isAwaitingUserSelection?.() === true) {
        return errorResult(SAND_AWAITING_USER_SEND_MESSAGE_BLOCKED);
      }
      const timestampMs = Date.now();
      const messageId = deps.onSendMessage(message, timestampMs);
      return new SendMessageResult({
        result: {
          case: "success",
          value: new SendMessageSuccess({
            timestamp: BigInt(timestampMs),
            ...(messageId == null || messageId.length === 0 ? {} : { messageId }),
          }),
        },
      });
    };
    return interactionHandler.executeToolCall(
      ctx,
      createSendMessageToolCall(baseToolCall),
      meta.toolCallId,
      run,
      (result) => createSendMessageToolCall(new SendMessageToolCall({ args: encodedArgs, result })),
    );
  };
  return createZodAgentTool("SEND_MESSAGE", {
    name: SAND_SEND_MESSAGE_TOOL_NAME,
    descriptionGenerator: () => SAND_SEND_MESSAGE_TOOL_DESCRIPTION,
    parameters: sendMessageParameters,
    execute: withSafeParsedArgs(
      sendMessageParameters,
      execute,
      createSendMessageToolCall(new SendMessageToolCall()),
    ),
    async render(_context: Context, output: SendMessageResult) {
      if (output.result.case === "error") {
        const detail = output.result.value.error.trim();
        return createStringResult(
          detail.length > 0
            ? `Failed to send the message to the user: ${detail}`
            : "Failed to send the message to the user.",
          true,
        );
      }
      const messageId = output.result.case === "success"
        ? output.result.value.messageId.trim()
        : "";
      return createStringResult(
        messageId.length > 0
          ? `Message sent to user. (id: ${messageId})`
          : "Message sent to user.",
      );
    },
    serializeError(error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return createSendMessageToolCall(new SendMessageToolCall({ result: errorResult(message) }));
    },
  });
}
