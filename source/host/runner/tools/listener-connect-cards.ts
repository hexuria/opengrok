export interface ListenerConnectCardDependencies {
  readonly trigger: unknown;
  readonly platformsInTrigger: (trigger: unknown) => readonly string[];
  readonly isListenerPlatformConnected?: (platform: string) => Promise<boolean>;
  readonly emit: (message: {
    readonly type: "listener-connect";
    readonly platform: string;
    readonly reason: string;
  }) => void;
  readonly displayName?: (platform: string) => string;
}

export async function surfaceListenerConnectCards(
  dependencies: ListenerConnectCardDependencies,
): Promise<string | null> {
  if (dependencies.isListenerPlatformConnected == null) return null;
  const platforms = dependencies.platformsInTrigger(dependencies.trigger);
  if (platforms.length === 0) return null;
  const disconnected: string[] = [];
  for (const platform of platforms) {
    try {
      if (!await dependencies.isListenerPlatformConnected(platform)) {
        disconnected.push(platform);
      }
    } catch {}
  }
  if (disconnected.length === 0) return null;
  for (const platform of disconnected) {
    dependencies.emit({
      type: "listener-connect",
      platform,
      reason: "so this routine can fire",
    });
  }
  const names = disconnected
    .map((platform) => dependencies.displayName?.(platform) ?? platform)
    .join(" and ");
  return `${names} ${disconnected.length === 1 ? "isn't" : "aren't"} connected to the user's Cursor account yet, so this routine won't fire until they connect. The connect card is already in the chat \u2014 say so in your own words, but don't paste a link or send them to settings, and don't ask them to report back: you're resumed automatically once it connects.`;
}
