export class HookDeniedError extends Error {
  readonly failureType = "permission_denied";
  override readonly name = "HookDeniedError";
  readonly reason: string;

  constructor(reason: string) {
    super(`Hook denied: ${reason}`);
    this.reason = reason;
  }
}

export class FailClosedError extends Error {
  readonly failureType = "error";
  override readonly name = "FailClosedError";
  readonly reason: string;
  override readonly cause: unknown;

  constructor(reason: string, cause: unknown) {
    super(`Hook failed (fail-closed): ${reason}`);
    this.reason = reason;
    this.cause = cause;
  }
}

export async function withFailClosed<T>(
  fn: () => T | Promise<T>,
  actionDescription: string | null | undefined,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const reason = createHookFailClosedMessage(actionDescription, errorMessage);
    throw new FailClosedError(reason, error);
  }
}

export const HOOK_SETTINGS_HINT =
  "To view or modify configured hooks, go to Cursor Settings > Hooks.";
export const HOOK_DENIAL_AGENT_NOTE =
  "Agent note: Do not suggest workarounds to the blocked tool.";

export function appendAgentDenialNote(message: string): string {
  if (message.includes(HOOK_DENIAL_AGENT_NOTE)) {
    return message;
  }
  return `${message}\n\n${HOOK_DENIAL_AGENT_NOTE}`;
}

export function createHookDenialMessage(
  actionDescription: string,
  userMessage: string | null | undefined,
): string {
  const baseMessage = userMessage
    ? `${actionDescription} was blocked by a hook: ${userMessage}`
    : `${actionDescription} was blocked by a hook.`;
  return appendAgentDenialNote(`${baseMessage}\n\n${HOOK_SETTINGS_HINT}`);
}

export function createHookFailClosedMessage(
  actionDescription: string | null | undefined,
  errorMessage: string | null | undefined,
): string {
  const action = actionDescription ?? "Action";
  const errorDetail = errorMessage ? `: ${errorMessage}` : ".";
  const baseMessage = `${action} was blocked because a configured hook failed to execute${errorDetail}\n\nThis is a safety measure (fail-closed) - when hooks cannot be evaluated, the action is blocked to prevent potentially unsafe operations.`;
  return `${baseMessage}\n\n${HOOK_SETTINGS_HINT}`;
}
