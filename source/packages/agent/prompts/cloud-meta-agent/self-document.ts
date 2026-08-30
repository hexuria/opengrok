import { createLogger, type Context } from "../../../context/index.js";
import { PrivacyCapability } from "../../../redaction/classification.js";
import {
  fromRedactedCoreMessage,
  toRedactedCoreMessage,
  type CoreMessageLike,
} from "../../../redaction/core-message.js";
import type { PrivacyMode } from "../../../redaction/privacy-mode.js";
import { NAMED_AGENT_STORE_SELF_PATH } from "../../constants.js";

type RedactedCoreMessage = Parameters<typeof fromRedactedCoreMessage>[0];

const logger = createLogger("@anysphere/agent");
const NAMED_AGENT_SELF_DOCUMENT_TAG = "agent_self_document";
const SELF_DOCUMENT_OPEN = `<${NAMED_AGENT_SELF_DOCUMENT_TAG}>`;
const SELF_DOCUMENT_CLOSE = `</${NAMED_AGENT_SELF_DOCUMENT_TAG}>`;
const SELF_DOCUMENT_BLOCK_REGEX = new RegExp(
  `${SELF_DOCUMENT_OPEN}[\\s\\S]*?${SELF_DOCUMENT_CLOSE}`,
);
const USER_INFO_CLOSE = "</user_info>";

export function renderNamedAgentSelfDocumentBlock(contents: string | null | undefined): string {
  const trimmed = contents?.trim();
  const rawBody = trimmed !== undefined && trimmed !== ""
    ? trimmed
    : `You have not written ${NAMED_AGENT_STORE_SELF_PATH} yet.`;
  const body = rawBody
    .replaceAll(SELF_DOCUMENT_OPEN, `<\\${NAMED_AGENT_SELF_DOCUMENT_TAG}>`)
    .replaceAll(SELF_DOCUMENT_CLOSE, `<\\/${NAMED_AGENT_SELF_DOCUMENT_TAG}>`);
  return [
    SELF_DOCUMENT_OPEN,
    `The current contents of your self document (${NAMED_AGENT_STORE_SELF_PATH}). This copy is refreshed for you automatically — never read the file to learn who you are.`,
    "",
    body,
    SELF_DOCUMENT_CLOSE,
  ].join("\n");
}

export function extractNamedAgentSelfDocumentBlock(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return SELF_DOCUMENT_BLOCK_REGEX.exec(text)?.[0];
}

function refreshNamedAgentSelfDocumentInText(
  text: string,
  contents: string | null | undefined,
): string | undefined {
  const block = renderNamedAgentSelfDocumentBlock(contents);
  if (SELF_DOCUMENT_BLOCK_REGEX.test(text)) {
    return text.replace(SELF_DOCUMENT_BLOCK_REGEX, () => block);
  }
  const userInfoCloseIndex = text.indexOf(USER_INFO_CLOSE);
  if (userInfoCloseIndex === -1) return undefined;
  const insertAt = userInfoCloseIndex + USER_INFO_CLOSE.length;
  return `${text.slice(0, insertAt)}\n\n${block}${text.slice(insertAt)}`;
}

export async function refreshNamedAgentSelfDocumentInMessages(
  ctx: Context,
  messages: readonly RedactedCoreMessage[],
  getNamedAgentSelfDocument: () => Promise<string | null | undefined>,
  privacyMode: PrivacyMode,
): Promise<readonly RedactedCoreMessage[]> {
  let contents: string | null | undefined;
  try {
    contents = await getNamedAgentSelfDocument();
  } catch (error) {
    logger.warn(ctx, "[self-document] refresh load failed; keeping stale copy", { error });
    return messages;
  }
  let foundTarget = false;
  let didRefresh = false;
  const refreshed = messages.map(message => {
    if (foundTarget || message.role !== "user") return message;
    const unredacted = fromRedactedCoreMessage(
      message,
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    ) as CoreMessageLike;
    if (unredacted.role !== "user") return message;
    const content = unredacted.content;
    if (typeof content === "string") {
      const updated = refreshNamedAgentSelfDocumentInText(content, contents);
      if (updated === undefined) return message;
      foundTarget = true;
      if (updated === content) return message;
      didRefresh = true;
      return toRedactedCoreMessage({ ...unredacted, content: updated }, privacyMode);
    }
    let didUpdatePart = false;
    const updatedParts = (content as readonly {
      readonly type: string;
      readonly text?: string;
      readonly [key: string]: unknown;
    }[]).map(part => {
      if (foundTarget || part.type !== "text") {
        return part;
      }
      const updated = refreshNamedAgentSelfDocumentInText(part.text!, contents);
      if (updated === undefined) return part;
      foundTarget = true;
      if (updated === part.text!) return part;
      didUpdatePart = true;
      return { ...part, text: updated };
    });
    if (!didUpdatePart) return message;
    didRefresh = true;
    return toRedactedCoreMessage({ ...unredacted, content: updatedParts }, privacyMode);
  });
  return didRefresh ? refreshed : messages;
}
