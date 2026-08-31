export type SandBoxRuntime = "remote" | "local-docker" | "windows365" | "opengrok";

/** Secret key for the OpenGrok server bearer. Never stored in settings.json. */
export const OPENGROK_GATEWAY_TOKEN_SECRET = "opengrok-gateway-token";

/** Account token from the server sign-in. Separate from the gateway bearer by design. */
export const OPENGROK_ACCESS_TOKEN_SECRET = "opengrok-access-token";
export const OPENGROK_DAEMON_TOKEN_SECRET = "opengrok-daemon-token";
export const OPENGROK_DAEMON_MACHINE_SECRET = "opengrok-daemon-machine";

export const DEFAULT_SAND_BOX_RUNTIME: SandBoxRuntime = "remote";

export const SAND_BOX_RUNTIME_OPTIONS = [
  {
    value: "remote" as const,
    label: "Grok VM",
    description: "Hosted Grok VM for this Cursor account (Grok Bot's Computer). Default for Cursor. Same remote computer and bots as official Grok Bot. Resetting it affects every client on this account.",
  },
  {
    value: "local-docker" as const,
    label: "Local VM",
    description: "A Linux desktop in Docker on this Mac. Optional — chat does not wait on it.",
  },
  {
    value: "windows365" as const,
    label: "Windows 365 for Agents",
    description: "Check out a Cloud PC from your Microsoft pool. Every agent reuses that machine until you check it in.",
  },
  {
    value: "opengrok" as const,
    label: "OpenGrok Server",
    description: "Your own OpenGrok server holds the bots and runs their work. Inference happens there, on each coworker's own model, so the router provider does not apply.",
  },
] as const;

export function isSandBoxRuntime(value: unknown): value is SandBoxRuntime {
  return value === "remote" || value === "local-docker" || value === "windows365" || value === "opengrok";
}

export function grokComputerAllowedForProvider(provider: string): boolean {
  return provider === "cursor";
}

export function boxRuntimeAllowedForProvider(runtime: SandBoxRuntime, provider: string): boolean {
  // The OpenGrok server is offered for every provider: choosing it is what makes
  // the provider moot, so gating it behind one would be backwards.
  if (runtime === "opengrok") return true;
  return runtime !== "remote" || grokComputerAllowedForProvider(provider);
}

/** The server owns inference, so the Router provider is not the one answering. */
export function boxRuntimeOwnsInference(runtime: SandBoxRuntime): boolean {
  return runtime === "opengrok";
}

export function coerceBoxRuntimeForProvider(runtime: SandBoxRuntime, provider: string): SandBoxRuntime {
  return boxRuntimeAllowedForProvider(runtime, provider) ? runtime : "local-docker";
}

export function usesLocalAgentHost(runtime: SandBoxRuntime): boolean {
  return runtime === "local-docker" || runtime === "windows365";
}

export function isLoopbackGatewayUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}
