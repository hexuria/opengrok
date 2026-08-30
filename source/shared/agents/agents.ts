export const SAND_AGENT_PURPOSES = ["disk-saver", "plugin-auth"] as const;
export type SandAgentPurpose = (typeof SAND_AGENT_PURPOSES)[number];

export function isSandAgentPurpose(value: unknown): value is SandAgentPurpose {
  return (
    typeof value === "string" &&
    (SAND_AGENT_PURPOSES as readonly string[]).includes(value)
  );
}

const TEMPLATE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function sanitizeTemplateId(value: unknown): string | undefined {
  return typeof value === "string" && TEMPLATE_ID_PATTERN.test(value)
    ? value
    : undefined;
}

export interface SandAgentActivity {
  readonly kind?: string;
  readonly tool?: string;
  readonly detail?: string;
  readonly target?: string;
  readonly callId?: string;
}

export function areAgentActivitiesEqual(
  left: SandAgentActivity | null | undefined,
  right: SandAgentActivity | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.kind === right.kind &&
    left.tool === right.tool &&
    left.detail === right.detail &&
    left.target === right.target &&
    left.callId === right.callId
  );
}

export const SAND_DEFAULT_AGENT_NAME = "New Bot";
export const LEGACY_SAND_DEFAULT_AGENT_NAME = "New Agent";

export function isSandDefaultAgentName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed === SAND_DEFAULT_AGENT_NAME ||
    trimmed === LEGACY_SAND_DEFAULT_AGENT_NAME
  );
}

export const GROUP_MAX_MEMBERS = 6;
export const MAX_AGENTS_PER_USER = 50;
export const SAND_AGENT_LIMIT_MESSAGE = `${MAX_AGENTS_PER_USER} is the maximum`;

export class SandAgentLimitError extends Error {
  constructor() {
    super(SAND_AGENT_LIMIT_MESSAGE);
    this.name = "SandAgentLimitError";
  }
}

export function isSandAgentLimitError(error: unknown): boolean {
  return error instanceof Error && error.message === SAND_AGENT_LIMIT_MESSAGE;
}
