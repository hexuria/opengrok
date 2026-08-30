export interface McpOAuthProviderPolicy {
  provider: "google-workspace";
  clientRegistration: "static";
  unauthenticatedConnect: boolean;
  rejectsCustomSchemeRedirects: boolean;
  authorizationParams: { access_type: "offline"; prompt: "consent" };
  scopes: readonly string[];
}

const GOOGLE_WORKSPACE_POLICY_BASE = {
  provider: "google-workspace",
  clientRegistration: "static",
  unauthenticatedConnect: true,
  rejectsCustomSchemeRedirects: true,
  authorizationParams: { access_type: "offline", prompt: "consent" },
} as const;

const policy = (scopes: readonly string[]): McpOAuthProviderPolicy => ({ ...GOOGLE_WORKSPACE_POLICY_BASE, scopes });

export const MCP_OAUTH_PROVIDER_POLICIES = new Map<string, McpOAuthProviderPolicy>([
  ["gmailmcp.googleapis.com", policy(["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/gmail.modify"])],
  ["drivemcp.googleapis.com", policy(["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"])],
  ["calendarmcp.googleapis.com", policy(["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/calendar.events.freebusy"])],
  ["docsmcp.googleapis.com", policy(["https://www.googleapis.com/auth/documents"])],
  ["sheetsmcp.googleapis.com", policy(["https://www.googleapis.com/auth/spreadsheets"])],
  ["slidesmcp.googleapis.com", policy(["https://www.googleapis.com/auth/presentations"])],
]);

export const GOOGLE_WORKSPACE_MCP_HOSTS = new Set([...MCP_OAUTH_PROVIDER_POLICIES].filter(([, value]) => value.provider === "google-workspace").map(([hostname]) => hostname));
export const MCP_OAUTH_EXTENSION_ID = "anysphere.cursor-mcp";
export const MCP_OAUTH_RETURN_PATH = "/oauth/return";
export const MCP_OAUTH_DESKTOP_RETURN_URL = `cursor://${MCP_OAUTH_EXTENSION_ID}${MCP_OAUTH_RETURN_PATH}`;
export const MCP_OAUTH_LOOPBACK_CALLBACK_URL = "http://localhost:8787/callback";
