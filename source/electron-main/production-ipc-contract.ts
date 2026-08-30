/** Exact production channel families registered by Electron main in 0.18. */
export const ELECTRON_MAIN_RPC_CHANNELS = {
  methodPrefix: "sand-rpc:main:m:",
  eventPrefix: "sand-rpc:main:e:",
} as const;

export const ELECTRON_MAIN_SYNC_IPC_CHANNELS = [
  "sand:theme-get-sync",
  "sand:egress-tunnel-get-sync",
  "sand:egress-tunnel-status-get-sync",
  "sand:webauthn-proxy-get-sync",
  "sand:experiments-snapshot-sync",
] as const;

export const ELECTRON_MAIN_INVOKE_IPC_CHANNELS = [
  "sand:secrets-list",
  "sand:secrets-reveal",
  "sand:secrets-upsert",
  "sand:secrets-delete",
  "sand:client-persistence-read",
  "sand:client-persistence-write",
  "sand:client-persistence-remove",
  "sand:client-persistence-list-keys",
  "sand:client-persistence-migrate",
  "sand:mcp-list",
  "sand:mcp-effective-plugins",
  "sand:mcp-catalog",
  "sand:mcp-team-popularity",
  "sand:mcp-plugin-logo",
  "sand:mcp-install",
  "sand:mcp-update-plugin-install",
  "sand:mcp-remove",
  "sand:mcp-uninstall-plugin",
  "sand:mcp-auth",
  "sand:mcp-rename-account",
  "sand:mcp-remove-account",
  "sand:mcp-set-instructions",
  "sand:mcp-list-server-tools",
  "sand:mcp-toggle-tool-disabled",
  "sand:coordinator-port-request",
  "sand:collections-list",
  "sand:collections-get",
  "sand:collections-rename",
  "sand:collections-delete",
  "sand:collections-remove-messages",
  "sand:collections-add-messages",
  "sand:collections-export-html",
  "sand:collections-export-json",
  "sand:collections-import-json",
  "sand:collections-open-original",
] as const;

export const ELECTRON_MAIN_POST_MESSAGE_CHANNELS = ["sand:coordinator-port"] as const;

export const ELECTRON_PRODUCTION_RESOURCE_LAYOUT = {
  main: "dist/electron-main/main.cjs",
  primaryPreload: "dist/electron-preload/preload.cjs",
  capabilityPreload: "dist/electron-preload/preload-sand-dev.cjs",
  devControlsPreload: "dist/electron-preload/preload-dev-controls.cjs",
  webviewPreload: "dist/electron-preload/preload-webview.cjs",
  vncPreload: "dist/electron-preload/preload-vnc.cjs",
  collectionsPreload: "dist/electron-preload/preload-collections.cjs",
  collectionsPage: "dist/electron-collections/page/collections.html",
  renderer: "dist/renderer/index.html",
  coordinator: "dist/node-agent-coordinator/main.cjs",
  mediaScheme: "sand-media",
} as const;
