export const COORDINATOR_MAIN_METHOD_TABLE = {
  uploadAttachment: { args: "object" },
  readAttachmentImage: { args: "object" },
  readAttachmentText: { args: "object" },
  readAttachmentChunk: { args: "object" },
  getHostSettings: { args: "none" },
  setHostSettings: { args: "object" },
  setBoxSecrets: { args: "object" },
  refreshMcp: { args: "object" },
  listBoxMcpServers: { args: "object" },
  updateForeverBox: { args: "object" },
  setWindowFocused: { args: "object" },
  getHostStatus: { args: "none" },
  listAgents: { args: "none" },
  createAgent: { args: "object" },
  deleteAgents: { args: "object" },
  deleteTranscriptEntries: { args: "object" },
  // Stock windowed transcript read. Only method NAMES the box gateway already
  // implements may appear here: agents can live on Cursor's remote box, whose
  // in-box gateway is Cursor's own build and rejects anything it does not know.
  getAgentTranscriptWindow: { args: "object" },
  getConversationOutline: { args: "object" },
  getSubagents: { args: "object" },
  setDevGatewayOffline: { args: "object" },
  setGatewayPaused: { args: "object" },
  clearAgentImageMetadata: { args: "object" }
} as const;

export type CoordinatorMainMethod = keyof typeof COORDINATOR_MAIN_METHOD_TABLE;

export function isCoordinatorMainMethod(name: string): name is CoordinatorMainMethod {
  return Object.hasOwn(COORDINATOR_MAIN_METHOD_TABLE, name);
}

