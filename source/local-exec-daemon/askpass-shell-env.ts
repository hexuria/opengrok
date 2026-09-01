/**
 * Puts the SUDO_ASKPASS trio into every agent shell's environment so `sudo -A`
 * reaches the app's password card. The daemon receives the paths and secret as
 * SAND_ASKPASS_* at spawn (electron-main mints them); this maps them onto the
 * names sudo and the shell backends already read. Windows, and a daemon spawned
 * without the trio (tests, an older main process), get nothing — sudo behaves
 * exactly as it did before this feature.
 */
export function askpassShellEnv(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv | undefined {
  // Windows has no askpass socket - UAC owns authentication - but the shell
  // still needs to know elevation is permitted, so it gets the flag alone.
  if (platform === "win32") {
    return source.SAND_ELEVATION_ALLOWED === "1" ? { SAND_ELEVATION_ALLOWED: "1" } : undefined;
  }
  const helperPath = source.SAND_ASKPASS_HELPER;
  const socketPath = source.SAND_ASKPASS_SOCKET;
  const secret = source.SAND_ASKPASS_SECRET;
  if (!helperPath || !socketPath || !secret) return undefined;
  return { SUDO_ASKPASS: helperPath, CURSOR_ASKPASS_SOCKET: socketPath, CURSOR_ASKPASS_SECRET: secret, SAND_ELEVATION_ALLOWED: "1" };
}
