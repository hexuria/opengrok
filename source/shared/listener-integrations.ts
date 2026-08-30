export type ListenerIntegrationPlatform = "github" | "slack";

export interface ListenerIntegrationManifest {
  readonly platform: ListenerIntegrationPlatform;
  readonly displayName: string;
  readonly blurb: string;
}

export const LISTENER_INTEGRATIONS: readonly ListenerIntegrationManifest[] = [
  {
    platform: "github",
    displayName: "GitHub",
    blurb: "Let automations watch a repo's PRs, comments, issues, and CI.",
  },
  {
    platform: "slack",
    displayName: "Slack",
    blurb: "Wake automations on Slack messages, mentions, and reactions.",
  },
];

export function listenerIntegrationManifest(
  platform: string,
): ListenerIntegrationManifest | undefined {
  return LISTENER_INTEGRATIONS.find((entry) => entry.platform === platform);
}
