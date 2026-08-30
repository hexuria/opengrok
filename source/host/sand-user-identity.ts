import { clampLine } from "../shared/sand-text.js";
export const MAX_FULL_NAME_LENGTH = 200;
export function normalizeSandUserFullName(raw: string | null | undefined): string | undefined { if (raw == null) return undefined; const clamped = clampLine(raw, MAX_FULL_NAME_LENGTH); return clamped.length > 0 ? clamped : undefined; }
export function renderUserIdentitySystemPrompt(fullName: string | null | undefined): string { const name = normalizeSandUserFullName(fullName); return name == null ? "" : `Your user is ${name}; when acting through their accounts and apps, such as Slack, speak as them and never refer to them in the third person.`; }
