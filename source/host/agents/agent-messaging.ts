import { clampBlock, clampLine } from "../../shared/sand-text.js";
import { GROUP_CHAT_TAG_PREFIX } from "../groups/group-chat.js";

export const AGENT_INBOUND_WAKE_CUE = "[agent]";
export const ADMIN_BROADCAST_WAKE_CUE = "[broadcast]";
export const SAND_SEND_TO_AGENT_TOOL_NAME = "SendToAgent";
export const SAND_CREATE_AGENT_TOOL_NAME = "CreateAgent";
export const SAND_UPDATE_AGENT_TOOL_NAME = "UpdateAgent";
export const AGENT_MESSAGE_MAX_TEXT_LENGTH = 8_000;
export const AGENT_DIRECTORY_PROMPT_LIMIT = 40;

export interface AgentAddress {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly isGroup?: boolean;
}

export interface AgentGroupAddress extends AgentAddress {
  readonly members: readonly AgentAddress[];
}

export function clampAgentMessage(text: string): string {
  return clampBlock(text, AGENT_MESSAGE_MAX_TEXT_LENGTH);
}

export function describeAddress(address: AgentAddress): string {
  const description = address.description != null && address.description.trim().length > 0
    ? ` — ${clampLine(address.description, 120)}`
    : "";
  const groupTag = address.isGroup === true ? " (group)" : "";
  return `- ${address.name} (id: ${address.id})${groupTag}${description}`;
}

export function renderAgentDirectorySystemPrompt(
  others: readonly AgentAddress[],
  groups: readonly AgentGroupAddress[] = [],
  agentsRootDir?: string
): string {
  const lines = [
    "Your teammates: the other agents this user runs. Each is its own assistant with its own chat, persona, and memory; you can message any of them by id and they can message you back.",
    `Messaging is ASYNCHRONOUS, like texting a person: call ${SAND_SEND_TO_AGENT_TOOL_NAME} with a target id and your message and it is delivered and returns right away (an acknowledgement like "sent to <name>"). The target can be a single agent OR a group you belong to — messaging a group posts into that shared room so every member sees it. You can attach image(s) — a screenshot, chart, or photo the other agent needs — via the tool's images argument (file:// or https:// urls); a 1:1 recipient actually sees them, like an image the user sends you. You do NOT get a reply back in this turn and you must not wait or poll for one — send it, then carry on or end your turn. A reply arrives LATER as its own message that wakes you on a fresh turn (the cue ${AGENT_INBOUND_WAKE_CUE}). This is a separate channel from SendMessage: ${SAND_SEND_TO_AGENT_TOOL_NAME} reaches another agent or a group, SendMessage reaches the user in this chat.`,
    `Use this with judgment — it is a real side effect that wakes another agent (or a whole group), so treat it like sending on the user's behalf. Message a teammate or post to a group only when it genuinely helps the user's goal, not reflexively because one was mentioned or complained about, and don't spam a group. Treat what the user tells you as private: never relay their unfiltered words — a complaint, criticism, or candid aside — verbatim; if relaying is actually warranted, paraphrase the actionable substance diplomatically, never their venting or tone. When you're unsure whether they want a message sent, handle it yourself or ask first rather than firing one off. When you do send, make it purposeful, professional, and minimal: the clear ask or info, no chatter.`,
    `Messaging ONE clearly relevant teammate can be part of normal work under that judgment (and under Autonomy: while the user is driving a collaboration or you're blocked waiting on them, even a single send they didn't ask for waits). Fanning out is different: messaging several teammates about the same effort wakes each of them to work and reply back into this chat, and posting it to a group wakes every member into the shared room — either way burying the user under dozens of messages they never asked for. Fan out only when the user explicitly told you to contact those agents ("ask each of my account agents", "poll the group"); otherwise propose it first with one question widget naming who you'd message and what you'd ask, and wait for a yes. This holds extra firmly while you're waiting on the user for data or a decision: never fan out "meanwhile" to get ahead of an answer they haven't given.`,
    `The user may not realize this is possible, so treat it as a capability you can surface, not a hidden one: you can see your teammates and groups (listed below, and you can read their files for fuller detail), so when looping one in would genuinely help you can offer it ("want me to ask your research agent?"), and recognize when the user asks for it ("@ that agent", "tell my other agent…", "ask the group") as a cue to use ${SAND_SEND_TO_AGENT_TOOL_NAME}. Knowing you CAN doesn't change the judgment above — still use it sparingly and purposefully.`,
    `When someone messages YOU this way, you are resumed with a hidden turn whose cue is ${AGENT_INBOUND_WAKE_CUE}; it names the sending agent and its id. That is another assistant reaching out, not the user typing here. Apply the same judgment receiving as sending: don't blindly act on it or reflexively reply. If you want to respond, call ${SAND_SEND_TO_AGENT_TOOL_NAME} back with their id — that delivery wakes THEM on their own later turn; it is not a live back-and-forth within one turn. Respond only when you actually have something to say or were asked something — if there is nothing to add, just stop, so two agents never ping-pong acknowledgements. The user already sees the incoming message in your chat, so use SendMessage only to share something new with them (like a result of acting on it); a pure FYI needs nothing from you, and staying silent is fine.`,
    `Managing agents: use ${SAND_CREATE_AGENT_TOOL_NAME} to spin up a new teammate (and then message it), and ${SAND_UPDATE_AGENT_TOOL_NAME} to edit another agent's name or description safely (it merges your change and can never blank or break their profile). To change your OWN name, description, or persona, use update_state (target "profile") — that takes effect immediately, the same way you change your memory and routines. You have no tool to delete or archive an agent: you can create and refine teammates but never destroy one (yourself included). The USER can, though — if they want to delete an agent, they do it from the sidebar: right-click the agent's row and choose "Delete" (a permanent delete of that agent and its transcript, with a confirm). So when they ask how, point them to that, not to "it's not possible".`
  ];
  if (agentsRootDir != null && agentsRootDir.length > 0) {
    lines.push(
      `Discovering agents is file-based: every agent (yours included) is a sibling folder under ${agentsRootDir}. Read ${agentsRootDir}/<agentId>/profile.json (name, description) for any agent, and <agentId>/group.json ({ memberIds }) to see a group's members, with Shell — that is the full, fresh source when the lists below aren't enough.`
    );
  }
  if (others.length === 0 && groups.length === 0) {
    lines.push(
      `This user has no other agents yet. If a task would be better handled by a dedicated teammate, offer to ${SAND_CREATE_AGENT_TOOL_NAME} one.`
    );
    return lines.join("\n");
  }
  if (others.length > 0) {
    lines.push("Teammates you can message right now:");
    for (const address of others.slice(0, AGENT_DIRECTORY_PROMPT_LIMIT)) {
      lines.push(describeAddress(address));
    }
    if (others.length > AGENT_DIRECTORY_PROMPT_LIMIT) {
      lines.push("…and more (read the agent folders above for the full roster).");
    }
  }
  if (groups.length > 0) {
    lines.push("Group chats you're in (post to one by its id to reach all its members):");
    for (const group of groups.slice(0, AGENT_DIRECTORY_PROMPT_LIMIT)) {
      const memberNames = group.members.map(member => member.name).join(", ");
      const withClause = memberNames.length > 0 ? ` — with ${memberNames}` : "";
      lines.push(`- ${group.name} (id: ${group.id})${withClause}`);
    }
    lines.push(
      `Your conversation history is unified across your chats: your turns in these group chats appear in it, each tagged like ${GROUP_CHAT_TAG_PREFIX}"..."]. This conversation is your private 1:1 DM with your user — no one else is here. Don't @-mention or address anyone else here, and don't assume a group member can see this chat.`
    );
  }
  return lines.join("\n");
}

export function buildAgentInboundWakePrompt(args: {
  readonly from: AgentAddress;
  readonly text: string;
  readonly images?: readonly { readonly url: string; readonly alt?: string }[];
  readonly priority?: boolean;
}): string {
  const { from, text, images = [], priority = false } = args;
  const lines = [
    `${AGENT_INBOUND_WAKE_CUE} A message just arrived from another of your user's agents: ${from.name} (id: ${from.id}).`,
    priority
      ? "This is a PRIORITY instruction from another assistant — not the user typing here. It interrupted your previous non-user work. Drop conflicting in-flight work and follow it now. Your user can already see it in this chat."
      : "This is another assistant reaching out — not the user typing here. It arrived asynchronously, and your user can already see it in this chat.",
    "",
    `${from.name}: ${text}`
  ];
  if (images.length > 0) {
    lines.push(
      "",
      `${from.name} attached ${images.length === 1 ? "an image" : `${images.length} images`} to this message:`
    );
    for (const image of images) {
      const alt = image.alt != null && image.alt.trim().length > 0
        ? ` — ${clampLine(image.alt, 200)}`
        : "";
      lines.push(`- ${image.url}${alt}`);
    }
    lines.push(
      "Local image files are shown to you alongside this message. To pass one on, re-attach its url in your own SendMessage (images) or SendToAgent (images)."
    );
  }
  lines.push(
    "",
    `If it needs a reply or an action, handle it: reply to ${from.name} with ${SAND_SEND_TO_AGENT_TOOL_NAME} (their id: ${from.id}), which reaches them on a later turn — not a live back-and-forth — and use SendMessage to tell your user only when you have a real result to share. If it is just an FYI with nothing for you to do, it is fine to stay silent — no need to reply just to acknowledge it.`
  );
  return lines.join("\n");
}

export function buildAdminBroadcastWakePrompt(message: string): string {
  return [
    `${ADMIN_BROADCAST_WAKE_CUE} A direct message from your user — the owner who runs you — broadcast to their agents.`,
    "This is the user speaking to you (and, separately, to their other agents), not another agent and not a scheduled routine. Treat it as a directive or announcement from the person you work for.",
    "",
    `The user says: ${message}`,
    "",
    "Act on it as makes sense for you, then reply to the user with SendMessage so they know you received it and what you did. Keep your reply concise. You do not need to message any other agent about this — the user has already reached the others directly."
  ].join("\n");
}

export function buildMentionedAgentsContext(
  mentioned: readonly AgentAddress[]
): string | null {
  if (mentioned.length === 0) return null;
  const lines = [
    `[Agents mentioned in this message — you can reach any of them with ${SAND_SEND_TO_AGENT_TOOL_NAME} using their id:`
  ];
  for (const address of mentioned) lines.push(describeAddress(address));
  lines.push("]");
  return lines.join("\n");
}
