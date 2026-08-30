import { CLAUDE_EVENT_TO_CURSOR_STEP, CLAUDE_TOOL_TO_CURSOR_TOOL, UNSUPPORTED_CLAUDE_EVENTS, UNSUPPORTED_CLAUDE_TOOLS } from "./claude-code-types.js";

interface Logger { warn(message: string): void; info(message: string): void }
interface ClaudeHookScript { type?: string; command?: string; prompt?: string; timeout?: number }
interface ClaudeHookEntry { matcher?: string; hooks: ClaudeHookScript[] }
interface CursorHookScript { type: "command" | "prompt"; command?: string; prompt?: string; matcher?: string; timeout?: number; loop_limit: null; failClosed: false }
export interface CursorHooksConfig { version: 1; hooks: Record<string, CursorHookScript[]> }
const noopLogger: Logger = { warn: () => {}, info: () => {} };

function transformToolMatcher(matcher: string | undefined, logger: Logger = noopLogger): string | null {
  if (!matcher || matcher === "*") return "*";
  const transformedTools: string[] = [], warnings: string[] = [];
  for (const tool of matcher.split("|")) {
    const trimmedTool = tool.trim();
    if (trimmedTool.startsWith("mcp__")) { const parts = trimmedTool.split("__"); if (parts.length >= 3) { transformedTools.push(`MCP:${parts.slice(2).join("__")}`); continue; } }
    const cursorTool = CLAUDE_TOOL_TO_CURSOR_TOOL[trimmedTool];
    if (cursorTool === null) { if ((UNSUPPORTED_CLAUDE_TOOLS as readonly string[]).includes(trimmedTool)) warnings.push(`Tool "${trimmedTool}" is not supported in Cursor and will be ignored`); continue; }
    if (cursorTool !== undefined) { if (!transformedTools.includes(cursorTool)) transformedTools.push(cursorTool); } else transformedTools.push(trimmedTool);
  }
  for (const warning of warnings) logger.warn(warning);
  return transformedTools.length === 0 ? null : transformedTools.join("|");
}
function transformHookScript(script: ClaudeHookScript, matcher: string | undefined): CursorHookScript | null {
  const base = { loop_limit: null, failClosed: false, ...(matcher && matcher !== "*" ? { matcher } : {}), ...(script.timeout !== undefined ? { timeout: script.timeout } : {}) } as const;
  if (script.type === "prompt") return script.prompt ? { type: "prompt", prompt: script.prompt, ...base } : null;
  return script.command ? { type: "command", command: script.command, ...base } : null;
}
function transformHookEntry(entry: ClaudeHookEntry, event: string, logger: Logger = noopLogger): CursorHookScript[] {
  const usesToolMatcher = event === "PreToolUse" || event === "PostToolUse"; let effectiveMatcher: string | undefined;
  if (usesToolMatcher) { const transformed = transformToolMatcher(entry.matcher, logger); if (transformed === null) { logger.warn(`All tools in matcher "${entry.matcher}" are unsupported, skipping hooks`); return []; } effectiveMatcher = transformed === "*" ? undefined : transformed; }
  else if (event === "SessionStart" || event === "PreCompact") { if (entry.matcher && entry.matcher !== "*" && entry.matcher !== "" && (event === "SessionStart" ? ["startup", "resume", "clear", "compact"].includes(entry.matcher) : ["manual", "auto"].includes(entry.matcher))) logger.warn(`${event} trigger matcher "${entry.matcher}" is not supported in Cursor, hooks will fire for all triggers`); effectiveMatcher = undefined; }
  else effectiveMatcher = undefined;
  const result: CursorHookScript[] = []; for (const script of entry.hooks) { const transformed = transformHookScript(script, effectiveMatcher); if (transformed) result.push(transformed); } return result;
}
export function transformClaudeHooksToConfig(claudeHooks: Record<string, unknown>, logger: Logger = noopLogger): CursorHooksConfig {
  const cursorHooks: Record<string, CursorHookScript[]> = {};
  for (const [eventName, entries] of Object.entries(claudeHooks)) {
    if ((UNSUPPORTED_CLAUDE_EVENTS as readonly string[]).includes(eventName)) { logger.warn(`Claude Code event "${eventName}" is not supported in Cursor and will be ignored`); continue; }
    const cursorStep = (CLAUDE_EVENT_TO_CURSOR_STEP as Record<string, string | null | undefined>)[eventName]; if (!cursorStep) { logger.warn(`Unknown Claude Code event "${eventName}", skipping`); continue; }
    const scripts: CursorHookScript[] = []; if (Array.isArray(entries)) for (const entry of entries) scripts.push(...transformHookEntry(entry as ClaudeHookEntry, eventName, logger)); else if (entries !== undefined) logger.warn(`Claude Code event "${eventName}" has invalid value (expected array), skipping`);
    if (scripts.length > 0) cursorHooks[cursorStep] = [...(cursorHooks[cursorStep] ?? []), ...scripts];
  }
  return { version: 1, hooks: cursorHooks };
}
export function detectHooksSchema(value: unknown): "cursor" | "claude-code" | "unknown" {
  if (typeof value !== "object" || value === null) return "unknown"; const hooks = typeof (value as Record<string, unknown>).hooks === "object" && (value as Record<string, unknown>).hooks !== null ? (value as Record<string, unknown>).hooks as Record<string, unknown> : null; if (!hooks) return "unknown";
  for (const candidate of Object.values(hooks)) { if (!Array.isArray(candidate) || candidate.length === 0) continue; const first = candidate[0]; if (typeof first !== "object" || first === null) continue; if ("hooks" in first && Array.isArray((first as Record<string, unknown>).hooks)) return "claude-code"; if ("command" in first || "prompt" in first || "type" in first) return "cursor"; }
  return "unknown";
}
