export interface OpenGrokDaemonIdentity {
  /** The server this machine enrolled with, as configured in Settings. */
  readonly gatewayUrl: string | null | undefined;
  /** The per-machine token the server minted at enrolment, shown once. */
  readonly token: string | null | undefined;
}

export interface DaemonConnectionDescriptor {
  readonly baseUrl: string;
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

/**
 * Give the local-exec daemon the credential its two routes actually accept.
 *
 * The descriptor the daemon reads carries whatever token the gateway handed
 * back, and for a box that is the gateway bearer - one shared secret naming
 * the gateway, not the machine. `/local-exec/requests` and `/local-exec/responses`
 * on our own server refuse it by design: they are the channel that runs commands
 * on somebody's Mac, so they demand the per-machine token minted at enrolment,
 * which names this machine and can be revoked on its own.
 *
 * The origin check is the point of the function, not a formality. The daemon
 * token authorises running commands here, so it goes to the server this machine
 * enrolled with and to nothing else - not to a box gateway, not to a server the
 * settings were later pointed away from. When anything fails to line up the
 * descriptor is returned untouched: the daemon then gets a 401 it can report,
 * which is a better outcome than a credential sent somewhere it was never meant
 * to go.
 */
export function withOpenGrokDaemonToken(connection: unknown, identity: OpenGrokDaemonIdentity): unknown {
  const token = identity.token ?? "";
  const gatewayUrl = identity.gatewayUrl ?? "";
  if (token.length === 0 || gatewayUrl.length === 0) return connection;
  if (typeof connection !== "object" || connection === null) return connection;
  const descriptor = connection as DaemonConnectionDescriptor;
  if (typeof descriptor.baseUrl !== "string") return connection;
  if (!sameOrigin(descriptor.baseUrl, gatewayUrl)) return connection;
  if (descriptor.token === token) return connection;
  return { ...descriptor, token };
}
