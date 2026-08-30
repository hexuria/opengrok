/**
 * Agent transcript prompt section recovered from the immutable UserInfo root.
 * Mac/Windows evidence: src/app/dist/host/host-main.cjs:554837-554844.
 * Region SHA-256: 3dae2644e524e1cab87ac2b4345eab8a820aa15c8a194f5cb104af598fb115e9
 */
import { jsx, jsxs } from "../../prompt-jsx/jsx-runtime.js";
import type { PromptNode } from "../../prompt-jsx/jsx-runtime.js";
import { AgentType } from "../utils/agent-config.js";

export function AgentTranscriptsSection({
  agentTranscriptsFolder,
  agentType,
  enableAgentChatLinks,
}: {
  readonly agentTranscriptsFolder: string;
  readonly agentType?: AgentType | undefined;
  readonly enableAgentChatLinks?: boolean | undefined;
}): PromptNode {
  const isIDE = agentType === AgentType.IDE;
  const citationInstruction = isIDE
    ? [
      `cite parent chat transcripts to the user as [<title for chat <=6 words>](<uuid excluding .jsonl>).${enableAgentChatLinks ? "" : " Do not cite subagent transcript files from this folder."}`,
      `Don't discuss the folder structure.`,
    ].join(" ")
    : `Don't cite the file directly to the user.`;
  return jsx("section", {
    title: "agent_transcripts",
    children: jsxs("p", {
      children: [
        "Agent transcripts (past chats) live in ",
        agentTranscriptsFolder,
        ". They have names like ",
        "<uuid>",
        ".jsonl, ",
        citationInstruction,
      ],
    }),
  });
}
