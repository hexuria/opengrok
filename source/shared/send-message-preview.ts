export const CURSOR_AGENT_FALLBACK_PREVIEW = "Cursor cloud agent";

export function cursorAgentPreviewText(title?: string | null): string {
  const trimmed = title?.trim();
  return trimmed != null && trimmed.length > 0
    ? `Cursor agent: ${trimmed}`
    : CURSOR_AGENT_FALLBACK_PREVIEW;
}

export function connectorsPreviewText(connectors: readonly string[]): string {
  return connectors.length > 0
    ? `Connect ${connectors.join(", ")}`
    : "Connect tools";
}

export type SendMessagePreviewInput =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "attachment"; readonly url: string }
  | { readonly type: "widget"; readonly widget: { readonly prompt: string } }
  | { readonly type: "cursor-agent"; readonly title?: string | null }
  | {
      readonly type: "secret-request";
      readonly secretRequest: { readonly label: string };
    }
  | {
      readonly type: "email-draft";
      readonly draft: { readonly subject: string; readonly body: string };
    }
  | { readonly type: "slack-draft"; readonly draft: { readonly body: string } }
  | {
      readonly type: "permission-request";
      readonly permission: { readonly title: string };
    }
  | {
      readonly type: "auto-review-approval";
      readonly approval: { readonly summary: string };
    }
  | {
      readonly type: "local-tool-permission";
      readonly ask: { readonly target: string };
    }
  | {
      readonly type: "connector";
      readonly variant: string;
      readonly connector: string;
    }
  | { readonly type: "connectors"; readonly connectors: readonly string[] }
  | {
      readonly type: "listener-connect";
      readonly platform: string;
    };

export function sendMessagePreviewText(message: SendMessagePreviewInput): string {
  switch (message.type) {
    case "text":
      return message.content;
    case "attachment":
      return message.url;
    case "widget":
      return message.widget.prompt;
    case "cursor-agent":
      return cursorAgentPreviewText(message.title);
    case "secret-request":
      return message.secretRequest.label;
    case "email-draft":
      return message.draft.subject || message.draft.body;
    case "slack-draft":
      return message.draft.body;
    case "permission-request":
      return message.permission.title;
    case "auto-review-approval":
      return `Approval required: ${message.approval.summary}`;
    case "local-tool-permission":
      return `Permission required: ${message.ask.target}`;
    case "connector":
      return message.variant === "connected"
        ? `${message.connector} connected`
        : `Connect ${message.connector}`;
    case "connectors":
      return connectorsPreviewText(message.connectors);
    case "listener-connect":
      return `Connect ${message.platform === "slack" ? "Slack" : "GitHub"}`;
  }
  return "Message";
}
