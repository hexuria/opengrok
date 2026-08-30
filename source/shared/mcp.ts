export const DEFAULT_MCP_ACCOUNT_KEY = "default";

export function normalizeMcpAccountLabel(rawLabel: string): string {
  return rawLabel.trim().toLowerCase();
}

export function provisionalMcpAccountServerIdentifier(
  rowIdentifier: string,
  accountKey: string,
): string {
  return accountKey === DEFAULT_MCP_ACCOUNT_KEY
    ? rowIdentifier
    : `${rowIdentifier}--${accountKey}`;
}

export const MAX_RENDERED_MCP_ACCOUNT_LABEL_LENGTH = 64;
export const MCP_LABEL_HOSTILE_CHARS =
  /[\u0000-\u001f\u007f"'`\\[\]{}()<>\u2028\u2029]/g;

export function encodeMcpAccountLabelForListing(label: string): string {
  const escaped = label.replace(
    MCP_LABEL_HOSTILE_CHARS,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `"${escaped}"`;
}

export function decodeMcpAccountLabelArgument(rawArgument: string): string {
  const value = rawArgument.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {}
  }
  return rawArgument;
}

export function formatMcpAccountLabelForPrompt(rawLabel: string): string {
  const inert = rawLabel
    .replace(/["'`\\[\]{}()<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return inert.slice(0, MAX_RENDERED_MCP_ACCOUNT_LABEL_LENGTH);
}

export function formatMcpAccountDisplayName(
  name: string,
  accountKey: string | null | undefined,
): string {
  return accountKey != null && accountKey !== DEFAULT_MCP_ACCOUNT_KEY
    ? `${name} (${formatMcpAccountLabelForPrompt(accountKey)})`
    : name;
}

export function isEffectivePluginInstalled(plugin: { readonly isEnabled: boolean }): boolean {
  return plugin.isEnabled;
}

export function uninstallClearedInstallRecord(result: {
  readonly removed: boolean;
  readonly reason?: string;
}): boolean {
  return result.removed || result.reason === "team-server";
}

export const MAX_CONNECTOR_ERROR_LENGTH = 300;
export const MAX_UNTRUSTED_MARKUP_SCAN_LENGTH = 16_384;

export function stripMarkupAndBoundConnectorError(raw: string): string {
  const collapsed = raw
    .slice(0, MAX_UNTRUSTED_MARKUP_SCAN_LENGTH)
    .replace(/<(script|style)\b[^<>]*>[\s\S]*?(?:<\/\1>|$)/gi, " ")
    .replace(/<[^<>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) return "";
  return collapsed.length > MAX_CONNECTOR_ERROR_LENGTH
    ? `${collapsed.slice(0, MAX_CONNECTOR_ERROR_LENGTH - 1).trimEnd()}…`
    : collapsed;
}
