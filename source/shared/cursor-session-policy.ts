export const RECONSTRUCTED_USER_DATA_DIRNAME = "OpenGrok";
/**
 * Every dirname the profile has lived under, newest first. Startup adopts the
 * first one that exists, so a rename never orphans someone's chats, and the
 * chain keeps working for an install that skipped a version. Names are only
 * ever added to the front, never removed.
 */
export const LEGACY_RECONSTRUCTED_USER_DATA_DIRNAMES = ["OpenGrok-0.27", "Grok-0.27"] as const;
/** @deprecated Prefer the full list; kept so existing imports keep resolving. */
export const LEGACY_RECONSTRUCTED_USER_DATA_DIRNAME = LEGACY_RECONSTRUCTED_USER_DATA_DIRNAMES[0];

export function shouldPersistSecretsOnDisk(env: NodeJS.ProcessEnv = {}, filePath = ""): boolean {
  if (env.SAND_PERSIST_SECRETS_ON_DISK === "0") return false;
  if (env.SAND_PERSIST_SECRETS_ON_DISK === "1") return true;
  return filePath.includes(RECONSTRUCTED_USER_DATA_DIRNAME);
}

export function isReconstructedUserDataPath(filePath: string): boolean {
  return filePath.includes(RECONSTRUCTED_USER_DATA_DIRNAME);
}

export type ProviderSwitchReason = "explicit-user-switch" | "launch" | "reinstall" | "reload";

/** Cursor stays signed in across launch, reinstall, and provider changes. Claude/Codex keep CLI sessions. */
export function shouldLogoutCursorForProviderChange(_reason: ProviderSwitchReason): boolean {
  return false;
}

export function cursorSessionPresent(tokens: {
  readonly accessToken?: string | null;
  readonly refreshToken?: string | null;
}): boolean {
  return typeof tokens.accessToken === "string" && tokens.accessToken.length > 0
    && typeof tokens.refreshToken === "string" && tokens.refreshToken.length > 0;
}

export const CURSOR_LOGIN_WALL_SKIP_STORAGE_KEY = "sand-cursor-login-skip";

export function readCursorLoginWallSkipped(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    return store?.getItem(CURSOR_LOGIN_WALL_SKIP_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeCursorLoginWallSkipped(storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    store?.setItem(CURSOR_LOGIN_WALL_SKIP_STORAGE_KEY, "1");
  } catch {
    // Renderer storage is best-effort; settings.json is the durable copy.
  }
}

export function shouldShowCursorLoginWall(
  account: { readonly kind: string } | null | undefined,
  options?: { readonly skipped?: boolean },
): boolean {
  if (options?.skipped === true) return false;
  return account != null && account.kind !== "logged-in";
}
