/**
 * Computer kinds the OpenGrok *server* advertises on ListGrokBotUserComputers.
 *
 * Distinct from PROVIDER_COMPUTER_KINDS in provider-computers.ts, which is the
 * local screen switcher (Cursor / Local VM / Windows 365 / remote box) when
 * this Mac owns the computer. OpenGrok server kinds are listed under Settings
 * → Computer once box runtime is "opengrok"; the desktop does not run them.
 *
 * `grok-box` is hexuria/box (guest HTTP :1337 exec, :1340 host, :6080 noVNC),
 * provisioned by opengrok-server — not vendored into this client.
 */
export const OPENGROK_COMPUTER_KINDS = ["local-docker", "ascii", "windows365", "grok-box"] as const;
export type OpenGrokComputerKind = (typeof OPENGROK_COMPUTER_KINDS)[number];

export const OPENGROK_COMPUTER_KIND_LABELS: Record<OpenGrokComputerKind, string> = {
  "local-docker": "Local VM",
  ascii: "box (Linux)",
  windows365: "Windows 365",
  "grok-box": "grok-box",
};

export function isOpenGrokComputerKind(value: unknown): value is OpenGrokComputerKind {
  return typeof value === "string" && (OPENGROK_COMPUTER_KINDS as readonly string[]).includes(value);
}

export function openGrokComputerKindLabel(kind: string | undefined): string {
  if (kind == null || kind.length === 0) return "";
  return isOpenGrokComputerKind(kind) ? OPENGROK_COMPUTER_KIND_LABELS[kind] : kind;
}

/**
 * Whether this server kind has a graphical desktop the client can embed.
 * local-docker on the server is headless (shell + files). ascii and grok-box
 * publish noVNC; windows365 is a Cloud PC when the server wires it.
 */
export function openGrokComputerHasScreen(kind: string | undefined): boolean {
  return kind === "grok-box" || kind === "ascii" || kind === "windows365";
}
