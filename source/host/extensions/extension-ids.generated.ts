export const HostExtensions = {
  ActionAudit: "action-audit", Attachments: "attachments", Auth: "auth", AutoReview: "auto-review",
  Automations: "automations", BoxLifecycle: "box-lifecycle", BoxStoreSync: "box-store-sync",
  BrowserUa: "browser-ua", CloudAgents: "cloud-agents", CodebaseTelemetry: "codebase-telemetry",
  ContentSearch: "content-search", CrossUserSharing: "cross-user-sharing", Experiments: "experiments",
  ForeverBox: "forever-box", HostUpgrade: "host-upgrade", Inference: "inference", LocalExec: "local-exec",
  LocalToolPermission: "local-tool-permission", ManagedSetup: "managed-setup", Mcp: "mcp", Memory: "memory",
  Notifications: "notifications", NotifyBus: "notify-bus", Secrets: "secrets", Session: "session",
  Settings: "settings", SourceMap: "source-map", StateBackstop: "state-backstop",
  TeachRecording: "teach-recording", Telemetry: "telemetry", Transcript: "transcript", Trays: "trays",
  TurnExecution: "turn-execution", Wallpaper: "wallpaper", WebauthnProxy: "webauthn-proxy"
} as const;

export type HostExtensionId = (typeof HostExtensions)[keyof typeof HostExtensions];

