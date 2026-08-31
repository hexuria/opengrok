/**
 * Puts the SUDO_ASKPASS trio into every agent shell's environment so `sudo -A`
 * reaches the app's password card. The daemon receives the paths and secret as
 * SAND_ASKPASS_* at spawn (electron-main mints them); this maps them onto the
 * names sudo and the shell backends already read. Windows, and a daemon spawned
 * without the trio (tests, an older main process), get nothing — sudo behaves
 * exactly as it did before this feature.
 */
export function askpassShellEnv(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv | undefined {
  if (platform === "win32") return undefined;
  const helperPath = source.SAND_ASKPASS_HELPER;
  const socketPath = source.SAND_ASKPASS_SOCKET;
  const secret = source.SAND_ASKPASS_SECRET;
  if (!helperPath || !socketPath || !secret) return undefined;
  return { SUDO_ASKPASS: helperPath, CURSOR_ASKPASS_SOCKET: socketPath, CURSOR_ASKPASS_SECRET: secret };
}
