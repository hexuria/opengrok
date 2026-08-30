export const ADMIN_COMMAND_DENYLIST_MAX_RULE_LENGTH = 512;
const isAdminCommandDenylistSeparator = (character: string): boolean => character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\u00a0" || character === "\u200b" || character === "\u200c" || character === "\u200d" || character === "\ufeff";

export function normalizeAdminCommandDenylistText(value: string): string {
  let result = "", pendingSeparator = false;
  for (const character of value) {
    if (isAdminCommandDenylistSeparator(character)) { pendingSeparator = true; continue; }
    if (pendingSeparator && result.length > 0) result += " ";
    pendingSeparator = false;
    result += character;
  }
  return result;
}

const isOnlyWildcards = (value: string): boolean => value.length > 0 && [...value].every((character) => character === "*");
export function parseAdminCommandDenylistColonRule(rule: string): { executablePattern: string; argsPattern: string } | undefined {
  const index = rule.indexOf(":");
  if (index <= 0) return undefined;
  const executablePattern = rule.slice(0, index).trim();
  if ([...executablePattern].some((character) => character.trim().length === 0)) return undefined;
  return { executablePattern, argsPattern: rule.slice(index + 1).trim() };
}

export function getAdminCommandDenylistRuleError(rule: string): string | null {
  const trimmed = normalizeAdminCommandDenylistText(rule).trim();
  if (trimmed.length === 0) return "Rule cannot be empty";
  if (trimmed.length > ADMIN_COMMAND_DENYLIST_MAX_RULE_LENGTH) return `Rule cannot exceed ${ADMIN_COMMAND_DENYLIST_MAX_RULE_LENGTH} characters`;
  if (isOnlyWildcards(trimmed)) return "Rule cannot match every command; be more specific than wildcards alone";
  if (trimmed.startsWith(":")) return "Colon rules need an executable before `:` (e.g. `aws:*s3 rm*`)";
  const colonRule = parseAdminCommandDenylistColonRule(trimmed);
  if (colonRule !== undefined && isOnlyWildcards(colonRule.executablePattern) && (colonRule.argsPattern.length === 0 || isOnlyWildcards(colonRule.argsPattern))) return "Rule cannot match every command; narrow the executable or argument pattern";
  return null;
}
