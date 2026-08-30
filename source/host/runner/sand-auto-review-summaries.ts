const SAND_AUTO_REVIEW_SECRET_KEY_PATTERN = /(?:authorization|api.?key|credential|password|secret|token)/i;
const SAND_AUTO_REVIEW_SECRET_VALUE_PATTERN = /^(?:bearer\s+)?[A-Za-z0-9_+\/-]{24,}={0,2}$/i;

function redactSandAutoReviewInlineSecrets(value: string): string {
  return value.replace(/(authorization|api.?key|password|secret|token)(\s*[:=]\s*)\S+/gi, "$1$2…");
}

export function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

export function compactHeadAndTail(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  let omittedChars = normalized.length - maxChars;
  let omittedLabel = "";
  let available = 2;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    omittedLabel = `…[${omittedChars} chars omitted]…`;
    available = Math.max(2, maxChars - omittedLabel.length);
    const actualOmittedChars = normalized.length - available;
    if (actualOmittedChars === omittedChars) break;
    omittedChars = actualOmittedChars;
  }
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${normalized.slice(0, headChars)}${omittedLabel}${normalized.slice(-tailChars)}`;
}

export function shellLocationPhrase(surface: string): string {
  return surface === "host_shell" ? "on your local computer" : "on Grok Bot's computer";
}

export function genericSandShellAutoReviewSummary(surface: string): string {
  return surface === "host_shell" ? "Run a command on your local computer" : "Run a command on Grok Bot's computer";
}

export function describeSandShellAutoReviewAction(args: {
  readonly surface: string;
  readonly description?: string;
  readonly workingDirectory?: string;
}): string {
  const location = shellLocationPhrase(args.surface);
  const description = args.description?.replace(/\s+/g, " ").trim();
  const cwd = args.workingDirectory === undefined ? "" : ` from ${compact(args.workingDirectory, 100)}`;
  if (description !== undefined && description.length > 0) {
    const head = description.replace(/[.!?]+$/u, "");
    return compact(`${head} ${location}${cwd}`, 340);
  }
  return compact(`${genericSandShellAutoReviewSummary(args.surface)}${cwd}`, 340);
}

export function redactMcpValue(value: unknown, key?: string, depth = 0): unknown {
  if (key !== undefined && SAND_AUTO_REVIEW_SECRET_KEY_PATTERN.test(key)) return "…";
  if (typeof value === "string") {
    const redacted = redactSandAutoReviewInlineSecrets(value);
    return SAND_AUTO_REVIEW_SECRET_VALUE_PATTERN.test(redacted) ? "…" : compactHeadAndTail(redacted, 160);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : "{…}";
  if (Array.isArray(value)) {
    const selected = value.length <= 6
      ? value
      : [...value.slice(0, 3), `${value.length - 6} items omitted`, ...value.slice(-3)];
    return selected.map((entry) => redactMcpValue(entry, undefined, depth + 1));
  }
  const allEntries = Object.entries(value);
  const entries: [string, unknown][] = allEntries.length <= 12
    ? allEntries
    : [...allEntries.slice(0, 6), ["…", `${allEntries.length - 12} fields omitted`], ...allEntries.slice(-6)];
  return Object.fromEntries(entries.map(([entryKey, entry]) => [
    compact(entryKey, 60),
    redactMcpValue(entry, entryKey, depth + 1),
  ]));
}

export function summarizeSandMcpAutoReviewAction(args: {
  readonly serverDisplayName: string;
  readonly toolName: string;
  readonly mcpArguments?: unknown;
}): string {
  const safeServer = compact(args.serverDisplayName, 80);
  const safeTool = compact(args.toolName, 80);
  const payload = redactMcpValue(args.mcpArguments ?? {}, undefined);
  const details = compactHeadAndTail(JSON.stringify(payload), 300);
  return `Use ${safeServer || "a connected service"} tool ${safeTool || "action"} with ${details}`;
}

export function genericSandMcpAutoReviewSummary(serverDisplayName: string): string {
  const safeServer = compact(serverDisplayName, 80);
  return safeServer.length > 0 ? `Use ${safeServer}` : "Use a connected service";
}

export const MCP_DESTINATION_KEYS = new Set([
  "channel", "channel_id", "channelid", "path", "page", "page_id", "pageid",
  "repo", "repository", "title", "name", "url",
]);

export function humanizeMcpToolAction(toolName: string): string | undefined {
  const words = compact(toolName, 80)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return undefined;
  if (words.length === 2
    && /^(send|create|update|delete|post|write|read|add|remove|open|close|list|search|fetch|get|set|upload|download|invite|share)$/.test(words[0] ?? "")
    && !/s$/i.test(words[1] ?? "")) {
    const article = /^[aeiou]/i.test(words[1] ?? "") ? "an" : "a";
    return `${words[0]} ${article} ${words[1]}`;
  }
  return words.join(" ");
}

export function mentionsServer(text: string, serverDisplayName: string): boolean {
  const server = serverDisplayName.trim();
  return server.length > 0 && text.toLowerCase().includes(server.toLowerCase());
}

export function safeMcpDestinationHint(mcpArguments: unknown): string | undefined {
  if (mcpArguments === undefined || mcpArguments === null || typeof mcpArguments !== "object" || Array.isArray(mcpArguments)) return undefined;
  for (const [rawKey, value] of Object.entries(mcpArguments)) {
    if (typeof value !== "string") continue;
    const key = rawKey.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (!MCP_DESTINATION_KEYS.has(key) || SAND_AUTO_REVIEW_SECRET_KEY_PATTERN.test(rawKey)) continue;
    const redacted = redactSandAutoReviewInlineSecrets(value).replace(/\s+/g, " ").trim();
    if (redacted.length === 0 || redacted.length > 80 || SAND_AUTO_REVIEW_SECRET_VALUE_PATTERN.test(redacted)) continue;
    return compact(redacted, 60);
  }
  return undefined;
}

export function fallbackSandMcpAutoReviewSummary(args: {
  readonly serverDisplayName: string;
  readonly toolName: string;
  readonly mcpArguments?: unknown;
}): string {
  const server = compact(args.serverDisplayName, 80);
  const action = humanizeMcpToolAction(args.toolName);
  const hint = safeMcpDestinationHint(args.mcpArguments);
  if (server.length === 0 && action === undefined) return "Use a connected service";
  if (action === undefined) return genericSandMcpAutoReviewSummary(server);
  const base = server.length > 0 ? `Use ${server} to ${action}` : `Use a connected service to ${action}`;
  if (hint === undefined || base.toLowerCase().includes(hint.toLowerCase())) return base;
  return `${base} to ${hint}`;
}

export function describeSandMcpAutoReviewAction(args: {
  readonly description?: string;
  readonly serverDisplayName: string;
  readonly toolName: string;
  readonly mcpArguments?: unknown;
}): string {
  const description = args.description?.replace(/\s+/g, " ").trim();
  const server = compact(args.serverDisplayName, 80);
  if (description !== undefined && description.length > 0) {
    const head = description.replace(/[.!?]+$/u, "");
    if (server.length > 0 && !mentionsServer(head, server)) return compact(`${head} with ${server}`, 340);
    return compact(head, 340);
  }
  return fallbackSandMcpAutoReviewSummary({
    serverDisplayName: args.serverDisplayName,
    toolName: args.toolName,
    ...(args.mcpArguments === undefined ? {} : { mcpArguments: args.mcpArguments }),
  });
}

export function summarizeSandAutomationWriteAction(args: {
  readonly operation: string;
  readonly name: string;
  readonly triggerDescription: string;
  readonly prompt: string;
  readonly isEnabled?: boolean;
  readonly referencingRoutineNames?: readonly string[];
}): string {
  const name = compact(args.name, 80) || "a routine";
  const instruction = compactHeadAndTail(redactSandAutoReviewInlineSecrets(args.prompt), 240);
  if (args.operation === "workflow_body") {
    const routines = args.referencingRoutineNames
      ?.map((routine) => compact(routine, 40))
      .filter((routine) => routine.length > 0)
      .slice(0, 3)
      .join(", ") || "standing orders";
    return `Change workflow \u201C${name}\u201D used by ${routines}: \u201C${instruction}\u201D`;
  }
  const when = compact(args.triggerDescription, 120) || "on a trigger";
  const verb = args.operation === "create" ? "Save" : "Change";
  const paused = args.isEnabled === false ? " (paused)" : "";
  return `${verb} the routine \u201C${name}\u201D${paused} to run ${when.toLowerCase()}: \u201C${instruction}\u201D`;
}

export function summarizeSandCloudAgentAction(args: {
  readonly action: string;
  readonly prompt: string;
  readonly agentId?: string;
  readonly imageCount?: number;
  readonly interrupt?: boolean;
  readonly repoUrl?: string;
  readonly title?: string;
}): string {
  const instruction = compactHeadAndTail(redactSandAutoReviewInlineSecrets(args.prompt), 240);
  const imageCount = args.imageCount ?? 0;
  const images = imageCount > 0 ? ` with ${imageCount} attached image${imageCount === 1 ? "" : "s"} it can see` : "";
  if (args.action === "reply") {
    const target = compact(args.agentId ?? "", 40) || "a cloud agent";
    const interrupt = args.interrupt === true ? " (interrupt)" : "";
    return `Send a follow-up to cloud agent ${target}${interrupt}${images}: \u201C${instruction}\u201D`;
  }
  const repo = compact(args.repoUrl ?? "", 120);
  const titled = args.title !== undefined && args.title.trim().length > 0 ? ` \u201C${compact(args.title, 80)}\u201D` : "";
  const where = repo.length > 0 ? ` on ${repo}` : "";
  return `Launch a cloud agent${titled}${where}${images}: \u201C${instruction}\u201D`;
}

export type CloudLifecycleAction = "rename" | "cancel" | "archive" | "unarchive" | "delete";

export function summarizeSandCloudAgentLifecycleAction(args: {
  readonly action: CloudLifecycleAction;
  readonly agentId: string;
  readonly title?: string;
}): string {
  const target = compact(args.agentId, 40) || "a cloud agent";
  switch (args.action) {
    case "rename": {
      const title = args.title !== undefined && args.title.trim().length > 0 ? ` to \u201C${compact(args.title, 80)}\u201D` : "";
      return `Rename cloud agent ${target}${title}`;
    }
    case "cancel": return `Cancel the active run of cloud agent ${target}`;
    case "archive": return `Archive cloud agent ${target}`;
    case "unarchive": return `Unarchive cloud agent ${target}`;
    case "delete": return `Permanently delete cloud agent ${target}`;
  }
}

export function summarizeSandSubagentAction(args: { readonly action: string; readonly prompt: string }): string {
  const instruction = compactHeadAndTail(redactSandAutoReviewInlineSecrets(args.prompt), 240);
  return args.action === "steer"
    ? `Send a follow-up to a running task: \u201C${instruction}\u201D`
    : `Run a task on Grok Bot's computer: \u201C${instruction}\u201D`;
}

export interface SandBrowserSummaryArgs {
  readonly op: string;
  readonly element?: string;
  readonly targetPageUrl?: string;
  readonly url?: string;
  readonly text?: string;
  readonly value?: string;
  readonly values?: readonly string[];
  readonly key?: string;
  readonly cdpMethod?: string;
  readonly cdpParams?: string;
  readonly tabsAction?: string;
  readonly tabIndex?: number;
}

export function summarizeSandBrowserAutoReviewAction(args: SandBrowserSummaryArgs): string {
  const element = args.element?.replace(/\s+/g, " ").trim();
  const target = element !== undefined && element.length > 0 ? `\u201C${compact(element, 160)}\u201D` : "an element";
  const page = args.targetPageUrl !== undefined && args.targetPageUrl.length > 0
    ? ` on ${compactHeadAndTail(redactSandAutoReviewInlineSecrets(args.targetPageUrl), 120)}`
    : "";
  const summarize = (action: string): string => compact(`${action}${page} in the box browser`, 340);
  switch (args.op) {
    case "navigate": return compact(`Open \u201C${redactSandAutoReviewInlineSecrets(args.url ?? "")}\u201D in the box browser`, 340);
    case "click":
    case "mouse_click_xy": return summarize(`Click ${target}`);
    case "type": return summarize(summarizeTypedText(args.text ?? ""));
    case "fill": return summarize(summarizeTypedText(args.value ?? ""));
    case "select_option": return summarize(`Select \u201C${redactSandAutoReviewInlineSecrets((args.values ?? []).join(", "))}\u201D in ${target}`);
    case "press_key": return summarize(`Press ${args.key?.slice(0, 80) ?? "a key"}`);
    case "drag": return summarize(`Drag ${target}`);
    case "cdp": return summarize(`Run CDP command ${args.cdpMethod?.slice(0, 120) ?? ""} with ${compactHeadAndTail(redactSandAutoReviewInlineSecrets(args.cdpParams ?? "{}"), 160)}`);
    case "tabs": return summarize(args.tabsAction === "close" ? `Close browser tab${args.tabIndex !== undefined ? ` ${args.tabIndex}` : ""}` : "Open a new browser tab");
    default: return compact(`Browser ${args.op} on Grok Bot's computer`, 340);
  }
}

export function summarizeTypedText(text: string): string {
  const redacted = redactSandAutoReviewInlineSecrets(text);
  const normalized = compactHeadAndTail(redacted, 80);
  const looksSensitive = redacted !== text
    || SAND_AUTO_REVIEW_SECRET_VALUE_PATTERN.test(text.trim())
    || /(?:api[_ -]?key|authorization|credential|password|secret|token)\s*[:=]/i.test(text)
    || (/^[A-Za-z0-9+/_=-]{24,}$/.test(text.trim()) && !text.trim().includes(" "));
  return looksSensitive || normalized.length === 0
    ? `Type ${text.length} characters`
    : `Type ${text.length} characters (\u201C${normalized}\u201D)`;
}

export function summarizeSandComputerTypedText(text: string): string {
  return `${summarizeTypedText(text)} on Grok Bot's computer`;
}
