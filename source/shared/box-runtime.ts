export type SandBoxRuntime = "remote" | "local-docker" | "windows365";

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
] as const;

export function isSandBoxRuntime(value: unknown): value is SandBoxRuntime {
  return value === "remote" || value === "local-docker" || value === "windows365";
}

export function grokComputerAllowedForProvider(provider: string): boolean {
  return provider === "cursor";
}

export function boxRuntimeAllowedForProvider(runtime: SandBoxRuntime, provider: string): boolean {
  return runtime !== "remote" || grokComputerAllowedForProvider(provider);
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
