export const DISCORD_PLATFORM = "discord";
export const SLACK_PLATFORM = "slack";

export interface ConnectorManifest {
  readonly platform: string;
  readonly displayName: string;
  readonly blurb: string;
  readonly credentialLabel: string;
  readonly availability: "available" | "coming-soon";
  readonly connectGuide: string;
}

export const CONNECTOR_MANIFESTS: readonly ConnectorManifest[] = [
  {
    platform: DISCORD_PLATFORM,
    displayName: "Discord",
    blurb: "Message in Discord servers and DMs (coming soon).",
    credentialLabel: "bot token",
    availability: "coming-soon",
    connectGuide: "",
  },
  {
    platform: SLACK_PLATFORM,
    displayName: "Slack",
    blurb: "Message in Slack channels and DMs (coming soon).",
    credentialLabel: "app token",
    availability: "coming-soon",
    connectGuide: "",
  },
];

export interface ChannelAddress {
  readonly platform: string;
  readonly chat: string;
}

export function findConnectorManifest(
  platform: string,
): ConnectorManifest | undefined {
  return CONNECTOR_MANIFESTS.find((manifest) => manifest.platform === platform);
}

export function hasChannelsToShow(
  manifests: readonly ConnectorManifest[],
  connections: readonly unknown[],
): boolean {
  const hasConnectable = manifests.some(
    (manifest) => manifest.availability === "available",
  );
  return hasConnectable || connections.length > 0;
}

export function formatChannelAddress(address: ChannelAddress): string {
  return `${address.platform}:${address.chat}`;
}

export function parseChannelAddress(raw: string): ChannelAddress | null {
  const trimmed = raw.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0) return null;
  const platform = trimmed.slice(0, separator).trim();
  const chat = trimmed.slice(separator + 1).trim();
  if (platform.length === 0 || chat.length === 0) return null;
  return { platform, chat };
}
