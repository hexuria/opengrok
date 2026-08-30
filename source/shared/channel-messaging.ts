import { clampLine } from "./sand-text.js";
import {
  findConnectorManifest,
  formatChannelAddress,
  hasChannelsToShow,
  parseChannelAddress,
  type ChannelAddress,
  type ConnectorManifest,
} from "./channels.js";

export const CHANNEL_CONFIG_FILENAME = "connection.json";
export const CHANNEL_MAX_LABEL_LENGTH = 80;
export const CHANNEL_INBOUND_WAKE_CUE = "[inbound]";
export const CHANNEL_DELIVERY_FAILED_WAKE_CUE = "[channel-delivery-failed]";
export const CHANNEL_CREDENTIAL_FIELD = "token";

export function clampChannelLabel(label: string): string {
  return clampLine(label, CHANNEL_MAX_LABEL_LENGTH);
}

export type ChannelOutboundInput =
  | {
      readonly type: "text";
      readonly content: string;
      readonly images?: readonly { readonly url: string }[];
    }
  | {
      readonly type: "attachment";
      readonly url: string;
      readonly alt?: string | null;
    }
  | { readonly type: string; readonly [key: string]: unknown };

export type ChannelOutboundMessage =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "attachment";
      readonly url: string;
      readonly caption: string | null;
    };

export function buildChannelOutboundMessage(
  message: ChannelOutboundInput,
): ChannelOutboundMessage | null {
  if (message.type === "text") {
    const text = message as Extract<ChannelOutboundInput, { type: "text" }>;
    const image = (text.images ?? []).find((entry) => entry.url.length > 0);
    if (image != null) {
      return {
        kind: "attachment",
        url: image.url,
        caption: text.content.length > 0 ? text.content : null,
      };
    }
    return text.content.length > 0 ? { kind: "text", text: text.content } : null;
  }
  if (message.type === "attachment") {
    const attachment = message as Extract<
      ChannelOutboundInput,
      { type: "attachment" }
    >;
    const caption =
      attachment.alt != null && attachment.alt.length > 0 ? attachment.alt : null;
    if (attachment.url.length > 0) {
      return { kind: "attachment", url: attachment.url, caption };
    }
    return caption != null ? { kind: "text", text: caption } : null;
  }
  return null;
}

export interface ChannelConnectionSummary {
  readonly platform: string;
  readonly label: string;
  readonly status: string;
  readonly detail?: string | null;
}

function describeConnection(connection: ChannelConnectionSummary): string {
  const manifest = findConnectorManifest(connection.platform);
  const platformName = manifest?.displayName ?? connection.platform;
  const detail =
    connection.status === "error" && connection.detail != null
      ? ` (${connection.detail})`
      : "";
  return `- ${platformName} "${connection.label}" [${connection.status}]${detail}. Address people on it as ${connection.platform}:<chat id>`;
}

export function renderChannelsSystemPrompt(
  manifests: readonly ConnectorManifest[],
  connections: readonly ChannelConnectionSummary[],
  location: string | null | undefined,
): string {
  if (location == null) return "";
  if (!hasChannelsToShow(manifests, connections)) return "";
  const available = manifests.filter(
    (manifest) => manifest.availability === "available",
  );
  const lines = [
    "Channels: outside messaging surfaces you can talk on, beyond this Grok Bot chat.",
    `Each connected channel lives in a subfolder at ${location} holding a ${CHANNEL_CONFIG_FILENAME}. That file holds only a label, never a credential; the secret is kept in a separate store you cannot read. To disconnect one, prefer the update_state tool (target "channel", action "disconnect", the platform); a background connector notices and closes the live connection within a few seconds.`,
    "Never ask the user to paste a token, API key, or password into the chat, and never write one into a file: that would persist it in the transcript or somewhere you can read it back. To collect any credential, send a SendMessage of type secret-request (connector + field + a clear label). The user types it into a masked field and the value goes straight to the secret store; you only learn that it was provided, never the value. You do not need the credential to check status; never cat the connection file expecting one.",
    "Every conversation on a channel has an address shaped like platform:chat (e.g. slack:C12345). An address names one chat; that is all routing needs.",
    `INBOUND: when someone messages you on a connected channel, you are woken with a hidden message that opens with the cue ${CHANNEL_INBOUND_WAKE_CUE} and names the source address and sender. That is a real person reaching out on that platform, not the user typing in this app. Reply to them on that same channel by calling SendMessage with a channel target set to their address; if you instead omit the channel, your message goes to this in-app Grok Bot chat (the user at their desk), not to them.`,
    `REACTIONS: the same ${CHANNEL_INBOUND_WAKE_CUE} cue also wakes you when someone reacts to one of your messages (e.g. ❤️). A reaction is a lightweight acknowledgement, not a question: you usually do not need to reply, only act on it if it is useful.`,
    "OUTBOUND: SendMessage takes an optional channel target. Set it to an address (e.g. slack:C12345) to deliver there; leave it off and the message lands in this in-app chat exactly as before. You choose where each message goes, so be deliberate: by default answer an inbound message on the channel it came from.",
    "Pace a channel reply exactly like the in-app chat: open with a quick one-line acknowledgement, then send each progress beat and the final result as its own SendMessage as it happens. Each SendMessage is delivered to the platform immediately as a separate message, so the person sees you respond in real time; never hold it all back for one long message at the end, the worst way to reply on a channel. Keep every one of those messages extra concise: a channel is a messaging app, so write the short, to-the-point messages a person texts, terser than your in-app replies. Lead with the answer, prefer one or two short sentences, and skip long multi-paragraph messages, exhaustive detail, and unprompted caveats; expand only if they ask.",
    "A channel only carries text and attachments, never the in-app widget or cursor-agent cards (those render only in this app), so degrade them to text when the conversation is on a channel: ask a multiple-choice question as plain text with the options as a numbered list and tell them to reply with their choice; reference a Cursor cloud agent as a plain https://cursor.com/agents/<bcId> link instead of a card; and for an attachment pass either a local file:// path or an https URL: the file is uploaded to the platform so they receive the real image or file, never a path.",
    "Platforms you can connect:",
  ];
  for (const manifest of available) {
    lines.push(`- ${manifest.displayName}: ${manifest.blurb}`);
    for (const guideLine of manifest.connectGuide.split("\n")) {
      lines.push(`  ${guideLine}`);
    }
  }
  const comingSoon = manifests.filter(
    (manifest) => manifest.availability === "coming-soon",
  );
  if (comingSoon.length > 0) {
    lines.push(
      `Coming soon (not connectable yet): ${comingSoon
        .map((manifest) => manifest.displayName)
        .join(", ")}.`,
    );
  }
  if (connections.length > 0) {
    lines.push("Currently connected:");
    for (const connection of connections) lines.push(describeConnection(connection));
  } else {
    lines.push(
      "No channels connected yet. Offer to connect one when it would help the user reach people where they already are.",
    );
  }
  return lines.join("\n");
}

export interface ChannelReaction {
  readonly emoji: string;
  readonly messageQuote?: string | null;
}

export interface ChannelInboundEnvelope {
  readonly address: ChannelAddress;
  readonly sender: string;
  readonly text: string;
  readonly reaction?: ChannelReaction | null;
}

export function formatChannelReactionSummary(reaction: ChannelReaction): string {
  if (reaction.messageQuote != null && reaction.messageQuote.length > 0) {
    return `reacted ${reaction.emoji} to your message: "${reaction.messageQuote}"`;
  }
  return `reacted ${reaction.emoji} to a message`;
}

export function buildChannelInboundWakePrompt(
  envelopes: readonly ChannelInboundEnvelope[],
): string {
  const grouped = new Map<string, ChannelInboundEnvelope[]>();
  for (const envelope of envelopes) {
    const key = formatChannelAddress(envelope.address);
    const bucket = grouped.get(key) ?? [];
    bucket.push(envelope);
    grouped.set(key, bucket);
  }
  const blocks: string[] = [];
  for (const [addressToken, bucket] of grouped) {
    const [head] = bucket;
    if (head == null) continue;
    const platform = findConnectorManifest(head.address.platform);
    const platformName = platform?.displayName ?? head.address.platform;
    const transcript = bucket
      .map((envelope) =>
        envelope.reaction != null
          ? `  ${envelope.sender} ${formatChannelReactionSummary(envelope.reaction)}`
          : `  ${envelope.sender}: ${envelope.text}`,
      )
      .join("\n");
    blocks.push(`On ${platformName}, from ${addressToken}:\n${transcript}`);
  }
  const hasMessage = envelopes.some((envelope) => envelope.reaction == null);
  const plural = envelopes.length === 1 ? "" : "s";
  const opening = hasMessage
    ? `${CHANNEL_INBOUND_WAKE_CUE} New message${plural} on a channel you are connected to.`
    : `${CHANNEL_INBOUND_WAKE_CUE} New reaction${plural} on a channel you are connected to.`;
  const closing = hasMessage
    ? "Reply to them by calling SendMessage with the channel target set to the address shown above. Open with a quick one-line acknowledgement first, then send progress and the result as separate messages as they happen, never one long message at the end. Keep each message short: this is a messaging app, so reply in brief, chat-style messages (lead with the answer, a sentence or two), not long ones. Keep working the rest of your task too, but do not leave them hanging."
    : "You don't need to reply; act on a reaction only if it's useful (e.g. acknowledge, adjust, or continue). If you do choose to respond, use SendMessage with the channel target shown above.";
  return [
    opening,
    "This is activity from someone on an outside platform, not the user typing in this app.",
    "",
    blocks.join("\n\n"),
    "",
    closing,
  ].join("\n");
}

export function humanizeChannelDeliveryFailure(
  addressToken: string,
  rawMessage: string,
): string {
  const address = parseChannelAddress(addressToken);
  const platformName =
    address != null
      ? (findConnectorManifest(address.platform)?.displayName ?? address.platform)
      : null;
  const trimmed = rawMessage.trim();
  if (address == null || /not a valid channel address/i.test(trimmed)) {
    return `"${addressToken}" isn't a valid channel address, so that message wasn't delivered.`;
  }
  if (trimmed === "No channel delivery mechanism is registered.") {
    return "Channel messaging isn't available on this computer, so that message wasn't delivered.";
  }
  if (/no live .* connection/i.test(trimmed)) {
    return `${platformName} isn't connected on this computer, so that message wasn't delivered. Connect ${platformName} (add its token) to send there.`;
  }
  return `Couldn't deliver that message to ${platformName}: ${trimmed}`;
}

export interface ChannelDeliveryFailure {
  readonly addressToken: string;
  readonly reason: string;
}

export function buildChannelDeliveryFailureWakePrompt(
  failures: readonly ChannelDeliveryFailure[],
): string {
  const lines = failures.map(
    (failure) => `- To ${failure.addressToken}: ${failure.reason}`,
  );
  const plural = failures.length === 1 ? "" : "s";
  return [
    `${CHANNEL_DELIVERY_FAILED_WAKE_CUE} A message you tried to send to a channel did not go through.`,
    "This is a system notice about your own outbound send, not the user typing in this app. You may have already told the user it was sent, so correct the record.",
    ...lines,
    `Tell the user plainly here, in this in-app chat (a SendMessage with no channel target), that the message${plural} didn't go through and why, so they aren't left believing it was delivered. Don't silently retry the same channel; if it isn't connected, offer to help connect it.`,
  ].join("\n");
}
