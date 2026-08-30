import {
  getAdminCommandDenylistRuleError,
  normalizeAdminCommandDenylistText,
  parseAdminCommandDenylistColonRule,
} from "../../utils/admin-command-denylist.js";
import { matchesCommandGlob } from "../../utils/command-glob.js";

interface ParsedCommand {
  readonly fullText: string;
}

export interface AdminCommandParsingResult {
  readonly parsingFailed: boolean;
  readonly executableCommands: readonly ParsedCommand[];
}

export interface AdminCommandDenylistMatchInput {
  readonly command: string;
  readonly parsingResult: AdminCommandParsingResult;
  readonly blockedCommands: readonly string[];
}

const ADMIN_COMMAND_DENYLIST_UNANALYZABLE_REASON =
  "Denied: this command could not be conclusively analyzed against your team's administrator command denylist, so it was blocked (fail-closed) and was not executed. It cannot be approved from this conversation; only a user can run it manually outside the agent. You may continue working on the task.";

function deriveAdminCommandDenylistMatchForms({
  command,
  parsingResult,
}: Pick<AdminCommandDenylistMatchInput, "command" | "parsingResult">): string[] {
  return [
    ...new Set([
      command,
      ...parsingResult.executableCommands.map((candidate) => candidate.fullText),
    ]),
  ];
}

const ANSI_C_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

function canonicalizeCommandForDenylistMatching(command: string): string {
  let result = "";
  let mode: "plain" | "single" | "double" | "ansi" = "plain";
  let index = 0;
  while (index < command.length) {
    const character = command[index]!;
    if (mode === "plain") {
      if (character === "$" && command[index + 1] === "'") {
        mode = "ansi";
        index += 2;
      } else if (character === "$" && command[index + 1] === '"') {
        mode = "double";
        index += 2;
      } else if (character === "'") {
        mode = "single";
        index += 1;
      } else if (character === '"') {
        mode = "double";
        index += 1;
      } else if (character === "\\" && index + 1 < command.length) {
        if (command[index + 1] !== "\n") {
          result += command[index + 1];
        }
        index += 2;
      } else {
        result += character;
        index += 1;
      }
      continue;
    }
    if (mode === "single") {
      if (character === "'") mode = "plain";
      else result += character;
      index += 1;
      continue;
    }
    if (mode === "double") {
      if (character === '"') {
        mode = "plain";
        index += 1;
        continue;
      }
      if (character === "\\" && index + 1 < command.length) {
        const escaped = command[index + 1]!;
        if (["$", "`", '"', "\\", "\n"].includes(escaped)) {
          if (escaped !== "\n") result += escaped;
          index += 2;
          continue;
        }
      }
      result += character;
      index += 1;
      continue;
    }
    if (character === "'") {
      mode = "plain";
      index += 1;
      continue;
    }
    if (character !== "\\" || index + 1 >= command.length) {
      result += character;
      index += 1;
      continue;
    }
    const escaped = command[index + 1]!;
    const namedEscape = ANSI_C_ESCAPES[escaped];
    if (namedEscape !== undefined) {
      result += namedEscape;
      index += 2;
      continue;
    }
    const encoded = escaped === "x"
      ? command.slice(index + 2).match(/^[0-9a-fA-F]{1,2}/)?.[0]
      : escaped === "u"
        ? command.slice(index + 2).match(/^[0-9a-fA-F]{1,4}/)?.[0]
        : escaped === "U"
          ? command.slice(index + 2).match(/^[0-9a-fA-F]{1,8}/)?.[0]
          : command.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    const isUnicodeEscape = escaped === "u" || escaped === "U";
    const radix = escaped === "x" || isUnicodeEscape ? 16 : 8;
    if (encoded !== undefined) {
      const value = Number.parseInt(encoded, radix);
      if (!isUnicodeEscape || value <= 0x10ffff) {
        result += isUnicodeEscape ? String.fromCodePoint(value) : String.fromCharCode(value);
        index += encoded.length + (radix === 16 ? 2 : 1);
        continue;
      }
    }
    result += escaped;
    index += 2;
  }
  return normalizeAdminCommandDenylistText(result);
}

function matchAdminCommandDenylistRule(rule: string, command: string): boolean {
  const trimmedRule = normalizeAdminCommandDenylistText(rule).trim();
  if (trimmedRule.length === 0) return false;
  if (getAdminCommandDenylistRuleError(trimmedRule) !== null) return true;
  return [
    command.trim(),
    normalizeAdminCommandDenylistText(command).trim(),
    canonicalizeCommandForDenylistMatching(command).trim(),
  ].some((commandForm) => matchRuleAgainstCommand(trimmedRule, commandForm));
}

function matchRuleAgainstCommand(trimmedRule: string, trimmedCommand: string): boolean {
  const colonRule = parseAdminCommandDenylistColonRule(trimmedRule);
  if (colonRule !== undefined) {
    const spaceIndex = trimmedCommand.indexOf(" ");
    const executable = spaceIndex === -1 ? trimmedCommand : trimmedCommand.slice(0, spaceIndex);
    const argsText = spaceIndex === -1 ? "" : trimmedCommand.slice(spaceIndex + 1).trim();
    if (matchesCommandGlob(colonRule.executablePattern, executable) && matchesCommandGlob(colonRule.argsPattern, argsText)) return true;
  }
  if (trimmedRule.includes("*")) return matchesCommandGlob(trimmedRule, trimmedCommand);
  return trimmedCommand === trimmedRule || trimmedCommand.startsWith(`${trimmedRule} `);
}

function findMatchingAdminCommandDenylistPattern({
  matchForms,
  blockedCommands,
}: { readonly matchForms: readonly string[]; readonly blockedCommands: readonly string[] }): string | undefined {
  const rules = blockedCommands.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (rules.length === 0) return undefined;
  const forms = matchForms.map((form) => form.trim()).filter((form) => form.length > 0);
  const effectiveForms = forms.length > 0 ? forms : [""];
  for (const rule of rules) {
    if (effectiveForms.some((command) => matchAdminCommandDenylistRule(rule, command))) return rule;
  }
  return undefined;
}

export function formatAdminCommandDenylistBlockReason(pattern: string): string {
  return `Denied: this command was blocked by administrator policy (denylist rule: ${pattern}) and was not executed. It cannot be approved from this conversation; only a user can run it manually outside the agent. You may continue working on the task.`;
}

export function getModelShellAdminCommandDenylistBlockReason({
  command,
  parsingResult,
  blockedCommands,
}: AdminCommandDenylistMatchInput): string | undefined {
  if (blockedCommands.length === 0) return undefined;
  if (parsingResult.parsingFailed || parsingResult.executableCommands.length === 0) return ADMIN_COMMAND_DENYLIST_UNANALYZABLE_REASON;
  const matchedPattern = findMatchingAdminCommandDenylistPattern({
    matchForms: deriveAdminCommandDenylistMatchForms({ command, parsingResult }),
    blockedCommands,
  });
  return matchedPattern === undefined ? undefined : formatAdminCommandDenylistBlockReason(matchedPattern);
}
