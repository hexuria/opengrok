import {
  CLOUD_AGENT_STORAGE_DISABLED,
  GATEWAY_ACCESS_DENIED_MESSAGE_MARKER,
  GATEWAY_NO_STORAGE_MESSAGE_MARKER,
} from "../../shared/gateway-reachability.js";

/**
 * Last known state of the account's hosted Grok VM.
 *
 * Deliberately free of the Connect client: the main edge reads this to answer
 * the renderer, and pulling the RPC stack in behind it would drag undici into
 * every bundle that touches the edge.
 */
export interface AccountComputerStatus {
  readonly ok: boolean;
  readonly detail: string;
  readonly gatewayHost: string | null;
}

const ACCOUNT_COMPUTER_IDLE: AccountComputerStatus = {
  ok: false,
  detail: "Not attached yet. Open a chat or the computer pane to wake Grok VM.",
  gatewayHost: null,
};

let lastAccountComputerStatus: AccountComputerStatus = ACCOUNT_COMPUTER_IDLE;

export function getAccountComputerStatus(): AccountComputerStatus {
  return lastAccountComputerStatus;
}

export function noteAccountComputerStatus(status: AccountComputerStatus): void {
  lastAccountComputerStatus = status;
}

export const AUTOMATION_FAILURE_HINT_HEADER = "x-automation-failure-hint";
export const SAND_UPDATE_REQUIRED_HINT = "SAND_CLIENT_UPDATE_REQUIRED";

const TOO_OLD = "This reconstructed 0.18 client is too old for the account computer. Official Grok Bot can still open that box.";
const NO_STORAGE = "Privacy mode blocks the shared computer (no_storage).";

/**
 * The sentence to show when the hosted Grok VM refuses.
 *
 * Reads Connect metadata structurally rather than importing ConnectError, so
 * the main edge can render a refusal without the RPC stack behind it.
 */
export function formatAccountComputerError(error: unknown): string {
  const metadata = (error as { metadata?: { get?: (key: string) => string | null | undefined } } | null)?.metadata;
  if (typeof metadata?.get === "function") {
    const hint = metadata.get(AUTOMATION_FAILURE_HINT_HEADER);
    if (hint === SAND_UPDATE_REQUIRED_HINT) return TOO_OLD;
    if (hint === CLOUD_AGENT_STORAGE_DISABLED) return NO_STORAGE;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(GATEWAY_ACCESS_DENIED_MESSAGE_MARKER)) {
    return "Cursor refused the shared computer for this account. Sign in with the same Cursor account official Grok Bot uses.";
  }
  if (message.includes(GATEWAY_NO_STORAGE_MESSAGE_MARKER)) return NO_STORAGE;
  if (message.includes(SAND_UPDATE_REQUIRED_HINT) || /update required/i.test(message)) return TOO_OLD;
  if (/gateway_url empty/i.test(message)) return "Cursor did not return a computer gateway for this account.";
  return message;
}
