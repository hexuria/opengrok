export const CLOUD_AGENT_STORAGE_DISABLED = "CLOUD_AGENT_STORAGE_DISABLED";
export const GATEWAY_NO_STORAGE_MESSAGE_MARKER = "sand box access blocked by privacy mode (no_storage)";
export const GATEWAY_ACCESS_DENIED_MESSAGE_MARKER = "sand box access refused by backend access gate (access_denied)";
export const SAND_BOX_BLOCKED = "SAND_BOX_BLOCKED";
export const SAND_BOX_BLOCK_REASON_KEY = "sandBoxBlockReason";
export const GATEWAY_BOX_BLOCKED_PREFIX = "sand box blocked by kill switch: ";
const UNIT_SEPARATOR_NEVER_IN_COPY = "\u001f";

export interface SandBoxBlockedInfo {
  reason: string;
  title: string;
  detail: string;
}

export function encodeSandBoxBlockedMessage(info: SandBoxBlockedInfo): string {
  const fields = [info.reason, info.title, info.detail].join(UNIT_SEPARATOR_NEVER_IN_COPY);
  return `${GATEWAY_BOX_BLOCKED_PREFIX}${fields}`;
}

export function hasSandBoxBlockedMarker(message: string): boolean {
  return message.includes(GATEWAY_BOX_BLOCKED_PREFIX);
}

export const SAND_CLIENT_PAUSE_REASON = "SAND_CLIENT_PAUSE";
export const SAND_CLIENT_PAUSE_BLOCKED_MESSAGE = encodeSandBoxBlockedMessage({
  reason: SAND_CLIENT_PAUSE_REASON,
  title: "",
  detail: ""
});

export function findSandBoxBlockedMessage(error: unknown): string | null {
  const seen = new Set<object>();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const node = current as { message?: unknown; cause?: unknown };
    if (typeof node.message === "string") {
      const start = node.message.indexOf(GATEWAY_BOX_BLOCKED_PREFIX);
      if (start !== -1) return node.message.slice(start);
    }
    current = node.cause;
  }
  return null;
}
