// Exact non-UNSPECIFIED enum union recovered from tools_pb.ts. Keeping the full
// list here makes drift and unsupported variants reviewable rather than silent.
export const SHIPPED_CLIENT_SIDE_TOOL_V2_UNION = Object.freeze([
  "READ_SEMSEARCH_FILES", "RIPGREP_SEARCH", "READ_FILE", "LIST_DIR", "EDIT_FILE",
  "FILE_SEARCH", "SEMANTIC_SEARCH_FULL", "DELETE_FILE", "REAPPLY",
  "RUN_TERMINAL_COMMAND_V2", "FETCH_RULES", "WEB_SEARCH", "MCP", "SEARCH_SYMBOLS",
  "BACKGROUND_COMPOSER_FOLLOWUP", "KNOWLEDGE_BASE", "FETCH_PULL_REQUEST", "DEEP_SEARCH",
  "CREATE_DIAGRAM", "FIX_LINTS", "READ_LINTS", "GO_TO_DEFINITION", "TASK", "AWAIT_TASK",
  "TODO_READ", "TODO_WRITE", "EDIT_FILE_V2", "LIST_DIR_V2", "READ_FILE_V2",
  "RIPGREP_RAW_SEARCH", "GLOB_FILE_SEARCH", "CREATE_PLAN", "LIST_MCP_RESOURCES",
  "READ_MCP_RESOURCE", "READ_PROJECT", "UPDATE_PROJECT", "TASK_V2", "CALL_MCP_TOOL",
  "APPLY_AGENT_DIFF", "ASK_QUESTION", "SWITCH_MODE", "GENERATE_IMAGE", "COMPUTER_USE",
  "WRITE_SHELL_STDIN", "RECORD_SCREEN", "WEB_FETCH", "REPORT_BUGFIX_RESULTS",
  "AI_ATTRIBUTION", "MCP_AUTH", "REFLECT", "AWAIT", "GET_MCP_TOOLS", "SEND_TO_USER",
  "CONNECT_SCM",
] as const);

// Exact `agent.v1.ToolCall.tool` oneof recovered from agent_pb.ts. This is a
// separate union from ClientSideToolV2: a similarly named member is not proof
// that its call/result messages can be converted losslessly.
export const SHIPPED_AGENT_TOOL_CALL_UNION = Object.freeze([
  "shellToolCall", "deleteToolCall", "globToolCall", "grepToolCall", "readToolCall",
  "updateTodosToolCall", "readTodosToolCall", "editToolCall", "lsToolCall",
  "readLintsToolCall", "mcpToolCall", "semSearchToolCall", "createPlanToolCall",
  "webSearchToolCall", "taskToolCall", "listMcpResourcesToolCall",
  "readMcpResourceToolCall", "applyAgentDiffToolCall", "askQuestionToolCall",
  "fetchToolCall", "switchModeToolCall", "generateImageToolCall",
  "recordScreenToolCall", "computerUseToolCall", "writeShellStdinToolCall",
  "reflectToolCall", "setupVmEnvironmentToolCall", "truncatedToolCall",
  "startGrindExecutionToolCall", "startGrindPlanningToolCall", "webFetchToolCall",
  "reportBugfixResultsToolCall", "aiAttributionToolCall", "prManagementToolCall",
  "mcpAuthToolCall", "awaitToolCall", "blameByFilePathToolCall",
  "getMcpToolsToolCall", "reportBugToolCall", "setActiveBranchToolCall",
  "communicateUpdateToolCall", "sendFinalSummaryToolCall", "updatePrCodeTourToolCall",
  "replaceEnvToolCall", "editPrLabelsToolCall", "recordCiInvestigationFindingsToolCall",
  "sendMessageToolCall", "fetchCloudAgentDataToolCall", "sendToUserToolCall",
  "piReadToolCall", "piBashToolCall", "piEditToolCall", "piWriteToolCall",
  "piGrepToolCall", "piFindToolCall", "piLsToolCall", "connectScmToolCall",
  "searchConversationsToolCall", "createGoalToolCall", "updateGoalToolCall",
  "adoptToolCall", "getAgentStatusToolCall", "sendToAgentToolCall",
  "readAgentTranscriptToolCall", "createAgentToolCall", "stopAgentToolCall",
] as const);

export const UNPROJECTED_AGENT_TOOL_CALL_ONEOFS = Object.freeze([
  "deleteToolCall", "globToolCall", "grepToolCall", "updateTodosToolCall",
  "readTodosToolCall", "lsToolCall", "readLintsToolCall", "semSearchToolCall",
  "createPlanToolCall", "applyAgentDiffToolCall", "fetchToolCall", "switchModeToolCall",
  "writeShellStdinToolCall", "reflectToolCall", "setupVmEnvironmentToolCall",
  "truncatedToolCall", "startGrindExecutionToolCall", "startGrindPlanningToolCall",
  "reportBugfixResultsToolCall", "aiAttributionToolCall", "prManagementToolCall",
  "blameByFilePathToolCall", "reportBugToolCall", "setActiveBranchToolCall",
  "communicateUpdateToolCall", "sendFinalSummaryToolCall", "updatePrCodeTourToolCall",
  "replaceEnvToolCall", "editPrLabelsToolCall", "recordCiInvestigationFindingsToolCall",
  "fetchCloudAgentDataToolCall", "sendToUserToolCall", "piReadToolCall",
  "piBashToolCall", "piEditToolCall", "piWriteToolCall", "piGrepToolCall",
  "piFindToolCall", "piLsToolCall", "connectScmToolCall", "searchConversationsToolCall",
  "createGoalToolCall", "updateGoalToolCall", "adoptToolCall", "getAgentStatusToolCall",
  "sendToAgentToolCall", "readAgentTranscriptToolCall", "createAgentToolCall",
  "stopAgentToolCall",
] as const);

export const UNPROJECTED_CLIENT_SIDE_TOOL_V2_VARIANTS = Object.freeze([
  "READ_SEMSEARCH_FILES", "RIPGREP_SEARCH", "READ_FILE", "LIST_DIR", "EDIT_FILE",
  "FILE_SEARCH", "SEMANTIC_SEARCH_FULL", "DELETE_FILE", "REAPPLY", "FETCH_RULES",
  "MCP", "SEARCH_SYMBOLS", "BACKGROUND_COMPOSER_FOLLOWUP", "KNOWLEDGE_BASE",
  "FETCH_PULL_REQUEST", "DEEP_SEARCH", "CREATE_DIAGRAM", "FIX_LINTS", "READ_LINTS",
  "GO_TO_DEFINITION", "TASK", "AWAIT_TASK", "TODO_READ", "TODO_WRITE", "LIST_DIR_V2",
  "RIPGREP_RAW_SEARCH", "GLOB_FILE_SEARCH", "CREATE_PLAN", "READ_PROJECT",
  "UPDATE_PROJECT", "APPLY_AGENT_DIFF", "SWITCH_MODE", "WRITE_SHELL_STDIN",
  "REPORT_BUGFIX_RESULTS", "AI_ATTRIBUTION", "REFLECT", "AWAIT", "SEND_TO_USER",
  "CONNECT_SCM",
] as const);

// This inventory is deliberately explicit: absent mappings must remain in the
// ordinary transcript instead of being relabelled as ClientSideToolV2 frames.
export const CLIENT_SIDE_TOOL_V2_PROJECTION_INVENTORY = Object.freeze({
  supported: Object.freeze({
    shellToolCall: "RUN_TERMINAL_COMMAND_V2",
    editToolCall: "EDIT_FILE_V2",
    readToolCall: "READ_FILE_V2 (Read and ExternalRead share this generated agent oneof)",
    mcpToolCall: "CALL_MCP_TOOL",
    taskToolCall: "TASK_V2",
    listMcpResourcesToolCall: "LIST_MCP_RESOURCES",
    readMcpResourceToolCall: "READ_MCP_RESOURCE",
    askQuestionToolCall: "ASK_QUESTION",
    mcpAuthToolCall: "MCP_AUTH",
    webSearchToolCall: "WEB_SEARCH",
    webFetchToolCall: "WEB_FETCH",
    computerUseToolCall: "COMPUTER_USE",
    generateImageToolCall: "GENERATE_IMAGE (the shipped call union has no params arm; rawArgs is preserved)",
    recordScreenToolCall: "RECORD_SCREEN",
    getMcpToolsToolCall: "GET_MCP_TOOLS",
  }),
  ordinaryTranscriptOnly: Object.freeze({
    sendMessageToolCall: "the shipped ClientSideToolV2 enum has no SendMessage variant",
    approvalInteractions: "host permission queries/cards are lifecycle transcript records, not ClientSideToolV2 call/result variants",
    awaitToolCall: "the enum has AWAIT but the shipped call/result unions have no await arms",
  }),
  unrecovered: Object.freeze({
    agentToolOneofs: UNPROJECTED_AGENT_TOOL_CALL_ONEOFS,
    clientSideVariants: UNPROJECTED_CLIENT_SIDE_TOOL_V2_VARIANTS,
    policy: "not projected until each agent result can be losslessly matched to a generated ClientSideToolV2 result",
    readBinaryOutputs: "READ_FILE_V2 carries text; binary/blob identifiers remain in ordinary transcript",
  }),
});
