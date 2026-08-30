export const AUTH_WATCH_POLL_INTERVAL_MS = 5_000;
export const AUTH_WATCH_TIMEOUT_MS = 15 * 60 * 1_000;
export const AUTH_WATCH_POLL_TIMEOUT_MS = 30_000;
export function authWatchKey(serverId: string, accountKey: string): string { return `${serverId}::${accountKey}`; }
