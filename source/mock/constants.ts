export const DEFAULT_MOCK_HOST = "127.0.0.1";
export const DEFAULT_MOCK_PORT = 8787;

export const MOCK_JWT_SUBJECT = "mock-user-hexuria";
export const MOCK_JWT_EMAIL = "hexuria@localhost";
export const MOCK_JWT_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

export const HEXURIA_AGENT_ID = "agent-hexuria";
export const FIREFLY_AGENT_ID = "agent-firefly";
export const GORK_AGENT_ID = "agent-gork";

export const MOCK_COMPUTER_MACHINE_ID = "machine-local-1";
export const MOCK_ATTACHMENT_PATH = "attachments/notes.txt";
export const MOCK_ATTACHMENT_BYTES = new TextEncoder().encode("fixture notes for the mock GrokBot server\n");

/** Mock-only Teach-a-task placeholder. No GrokBot Teach RPC exists in proto. */
export const MOCK_TEACH_ATTACHMENT_PATH = "attachments/teach-demo.mp4";
export const MOCK_TEACH_ATTACHMENT_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31, 0x61, 0x76, 0x63, 0x31,
]);
export const HOST_TITLE_JOB_PREFIX = "Generate a short title";

/** RPCs with in-memory behaviour. Everything else on GrokBotService returns an empty proto. */
export const REAL_GROK_BOT_RPC_NAMES = [
  "ListGrokBotAgents",
  "CreateGrokBotAgent",
  "UpdateGrokBotAgent",
  "DeleteGrokBotAgent",
  "ListGrokBotTranscriptEntries",
  "CommitGrokBotTranscriptEntries",
  "WatchGrokBotTranscripts",
  "SendGrokBotUserMessage",
  "GetGrokBotSendStatus",
  "ListGrokBotUserComputers",
  "SetGrokBotAgentClientState",
  "ReadGrokBotAgentAttachmentChunk",
] as const;

export const CURSOR_BLOCKED_HOSTS = ["api2.cursor.sh", "cursor.com"] as const;
