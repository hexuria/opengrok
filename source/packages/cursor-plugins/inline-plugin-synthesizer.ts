import { mkdir, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { sanitizeFilename } from "../utils/path-matchers.js";

interface InlineHook {
  hookStep?: string;
  isActive?: boolean;
  operatingSystems?: string[];
  hookType?: string;
  promptContent?: string;
  promptModel?: string;
  scriptContent?: string;
}
interface InlineContent {
  rules?: Array<{ name: string; content?: string; isActive?: boolean; globs?: string[]; isRequired?: boolean }>;
  commands?: Array<{ name: string; content?: string; isActive?: boolean; description?: string }>;
  hooks?: InlineHook[];
  mcpServers?: Array<{ name: string; config?: unknown }>;
}

function currentOperatingSystemName(): "Windows" | "Macintosh" | "Linux" {
  const currentPlatform = platform();
  return currentPlatform === "win32" ? "Windows" : currentPlatform === "darwin" ? "Macintosh" : "Linux";
}
function appliesToCurrentOperatingSystem(hook: InlineHook): boolean { return !hook.operatingSystems || hook.operatingSystems.length === 0 || hook.operatingSystems.includes(currentOperatingSystemName()); }

export async function synthesizeInlinePluginDir(options: { targetDir: string; inlineContentJson: string; pluginName: string }): Promise<void> {
  const { targetDir, inlineContentJson, pluginName } = options;
  const content = JSON.parse(inlineContentJson) as InlineContent;
  await mkdir(targetDir, { recursive: true });
  const manifestPaths: { rules?: string[]; commands?: string[] } = {};
  if (content.rules && content.rules.length > 0) {
    const rulesDir = join(targetDir, "rules"); await mkdir(rulesDir, { recursive: true }); const rulePaths: string[] = [];
    for (const rule of content.rules) {
      if (!rule.content || rule.isActive === false) continue;
      const fileName = `${sanitizeFilename(rule.name)}.md`, frontmatterLines: string[] = [];
      frontmatterLines.push(`description: ${yamlQuote(rule.name)}`);
      if (rule.globs && rule.globs.length > 0) frontmatterLines.push(`globs: ${yamlQuote(rule.globs.join(", "))}`);
      frontmatterLines.push(`alwaysApply: ${rule.isRequired === true}`);
      await writeFile(join(rulesDir, fileName), `---\n${frontmatterLines.join("\n")}\n---\n\n${rule.content}`, "utf-8");
      rulePaths.push(`rules/${fileName}`);
    }
    if (rulePaths.length > 0) manifestPaths.rules = rulePaths;
  }
  if (content.commands && content.commands.length > 0) {
    const commandsDir = join(targetDir, "commands"); await mkdir(commandsDir, { recursive: true }); const commandPaths: string[] = [];
    for (const command of content.commands) {
      if (!command.content || command.isActive === false) continue;
      const fileName = `${sanitizeFilename(command.name)}.md`;
      const header = command.description ? `---\ndescription: ${yamlQuote(command.description)}\n---\n\n` : "";
      await writeFile(join(commandsDir, fileName), header + command.content, "utf-8"); commandPaths.push(`commands/${fileName}`);
    }
    if (commandPaths.length > 0) manifestPaths.commands = commandPaths;
  }
  if (content.hooks && content.hooks.length > 0) {
    const hooksDir = join(targetDir, "hooks"); await mkdir(hooksDir, { recursive: true });
    const hooksConfig: Record<string, unknown[]> = {};
    for (const hook of content.hooks) {
      const step = hook.hookStep; if (!step || hook.isActive === false || !appliesToCurrentOperatingSystem(hook)) continue;
      hooksConfig[step] ??= [];
      if (hook.hookType === "prompt") hooksConfig[step].push({ type: "prompt", prompt: hook.promptContent ?? "", ...(hook.promptModel ? { model: hook.promptModel } : {}) });
      else hooksConfig[step].push({ type: "command", command: hook.scriptContent ?? "" });
    }
    await writeFile(join(hooksDir, "hooks.json"), JSON.stringify({ version: 1, hooks: hooksConfig }, null, 2), "utf-8");
  }
  if (content.mcpServers && content.mcpServers.length > 0) {
    const mcpConfig: Record<string, unknown> = {};
    for (const server of content.mcpServers) if (server.config) mcpConfig[server.name] = server.config;
    if (Object.keys(mcpConfig).length > 0) await writeFile(join(targetDir, ".mcp.json"), JSON.stringify({ mcpServers: mcpConfig }, null, 2), "utf-8");
  }
  const pluginJsonDir = join(targetDir, ".cursor-plugin"); await mkdir(pluginJsonDir, { recursive: true });
  await writeFile(join(pluginJsonDir, "plugin.json"), JSON.stringify({ name: pluginName, ...manifestPaths }, null, 2), "utf-8");
}

function yamlQuote(value: string): string {
  return /[\n\r:#[\]{}&*!|>'"%@`]/.test(value) || value.startsWith(" ") || value.endsWith(" ")
    ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : value;
}
