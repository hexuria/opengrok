export const GATEWAY_WEBAUTHN_REQUESTS_PATH = "/webauthn/requests";
export const GATEWAY_WEBAUTHN_RESPONSES_PATH = "/webauthn/responses";
export const SAND_WEBAUTHN_HEARTBEAT_INTERVAL_MS = 10_000;

export const SAND_NO_WEBAUTHN_MACHINE_MESSAGE =
  "Your computer isn't connected right now, so the security key can't be reached. Open Grok Bot on the machine your key is plugged into and try again.";

export const SAND_WEBAUTHN_MACHINE_UNAVAILABLE_MESSAGE =
  "Your computer looks disconnected, so the security key can't be reached. Reconnect it and try again.";

export const SAND_WEBAUTHN_LIVENESS_WINDOW_MS = 30_000;
export const SAND_WEBAUTHN_CEREMONY_TIMEOUT_MS = 120_000;

export type SandWebAuthnOriginClass = "cursor_com" | "subdomain" | "external";

export function sandWebAuthnOriginClass(origin: string): SandWebAuthnOriginClass {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return "external";
  }
  if (hostname === "cursor.com") return "cursor_com";
  return hostname.endsWith(".cursor.com") ? "subdomain" : "external";
}

export interface WebAuthnCeremony {
  readonly kind: string;
  readonly origin: string;
  readonly [key: string]: unknown;
}

export type WebAuthnRequestFrame =
  | { readonly kind: "welcome"; readonly providerId: string }
  | { readonly kind: "ceremony"; readonly requestId: string; readonly ceremony: WebAuthnCeremony }
  | { readonly kind: "cancel"; readonly requestId: string };

export type WebAuthnResponseFrame =
  | { readonly kind: "hello"; readonly computerId?: string; readonly label?: string }
  | { readonly kind: "ping" }
  | { readonly kind: "stage"; readonly requestId: string; readonly stage: "grant" | "sign"; readonly outcome: "ok" | "declined" | "failed" }
  | { readonly kind: "result"; readonly requestId: string; readonly credentialJson: unknown }
  | { readonly kind: "error"; readonly requestId: string; readonly name: string; readonly message: string; readonly code?: string };
