import { SAND_DEEP_LINK_SCHEME } from "../../shared/deep-link.js";

export const SAND_AUTH_REDIRECT_TARGET = SAND_DEEP_LINK_SCHEME;
export const SAND_AUTH_PROTOCOL_SCHEME = SAND_DEEP_LINK_SCHEME;

const PROTOCOL_TOKEN = /^[a-z][a-z0-9+.-]{1,31}$/;

export interface AuthProtocolApp {
  setAsDefaultProtocolClient?(protocol: string, path?: string, args?: readonly string[]): boolean;
}

export interface AuthCallbackRegistration {
  readonly redirectTarget: string;
  readonly protocolScheme: string;
  readonly registered: boolean;
  readonly skipped: boolean;
}

function configuredToken(value: string | undefined, fallback: string, label: string): string {
  const token = value?.trim().toLowerCase();
  if (token == null || token.length === 0) return fallback;
  if (!PROTOCOL_TOKEN.test(token)) throw new Error(`Invalid ${label}: ${JSON.stringify(value)}.`);
  return token;
}

/**
 * `sand` is the only redirect target currently emitted by cursor.com. A
 * future backend-specific target may be selected explicitly, but must remain
 * a protocol-safe token and must be paired with the same server contract.
 */
export function resolveAuthRedirectTarget(env: NodeJS.ProcessEnv = process.env): string {
  return configuredToken(env.SAND_AUTH_REDIRECT_TARGET, SAND_AUTH_REDIRECT_TARGET, "SAND_AUTH_REDIRECT_TARGET");
}

export function resolveAuthProtocolScheme(env: NodeJS.ProcessEnv = process.env): string {
  return configuredToken(env.SAND_AUTH_CALLBACK_SCHEME, resolveAuthRedirectTarget(env), "SAND_AUTH_CALLBACK_SCHEME");
}

/**
 * Register only the reconstructed packaged app as the handler for the scheme
 * used by its auth redirect. Electron writes the per-user Windows protocol
 * registration and asks LaunchServices to select this signed bundle on macOS.
 * The original application bundle is never edited or removed.
 */
export function registerAuthCallbackProtocol(options: {
  readonly app: AuthProtocolApp;
  readonly isPackaged: boolean;
  readonly isLabBuild: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): AuthCallbackRegistration {
  const env = options.env ?? process.env;
  const redirectTarget = resolveAuthRedirectTarget(env);
  const protocolScheme = resolveAuthProtocolScheme(env);
  if (!options.isPackaged || options.isLabBuild) return { redirectTarget, protocolScheme, registered: false, skipped: true };
  if (typeof options.app.setAsDefaultProtocolClient !== "function") return { redirectTarget, protocolScheme, registered: false, skipped: true };
  return { redirectTarget, protocolScheme, registered: options.app.setAsDefaultProtocolClient(protocolScheme), skipped: false };
}
