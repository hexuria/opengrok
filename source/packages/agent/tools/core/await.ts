import { RE2JS } from "re2js";
import { z } from "zod";

import type { Context } from "../../../context/core.js";
import { createSpan } from "../../../context/otel.js";
import { createStringResult } from "../../../chat-inference/prompt-executor.js";
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../agent-exec/remote.js";
import { lsExecutorResource } from "../../../agent-exec/ls.js";
import { readExecutorResource } from "../../../agent-exec/read.js";
import { subagentExecutorResource } from "../../../agent-exec/subagent.js";
import { subagentAwaitExecutorResource } from "../../../agent-exec/subagent-await.js";
import { getConversationId } from "../../utils/request-id.js";
import { extractTerminalId } from "../../../utils/path-matchers.js";
import {
  AwaitArgs,
  AwaitError,
  AwaitResult,
  AwaitSuccess,
  AwaitTaskComplete,
  AwaitTaskStillRunning,
  AwaitToolCall,
} from "../../../proto/generated/agent/v1/await_tool_pb.js";
import { ReadArgs } from "../../../proto/generated/agent/v1/read_exec_pb.js";
import { LsArgs } from "../../../proto/generated/agent/v1/ls_exec_pb.js";
import {
  SubagentArgs,
  SubagentAwaitArgs,
  SubagentAwaitComplete,
  SubagentAwaitError,
  SubagentAwaitNotFound,
  SubagentAwaitResult,
  SubagentAwaitStillRunning,
} from "../../../proto/generated/agent/v1/subagent_exec_pb.js";
import { ToolCall } from "../../../proto/generated/agent/v1/agent_pb.js";
import { ToolCallAbortedError, ToolCallArgParseError, createZodAgentTool, withSafeParsedArgs } from "../common.js";

const DEFAULT_BLOCK_UNTIL_MS = 30_000;
const SHELL_CHECK_SLICE_MS = 250;
const AWAIT_TOOL_MODEL_NAME_DEFAULT = "Await";
const AWAIT_TOOL_MODEL_NAME_SHELL_ONLY = "AwaitShell";
const WAITING_FOR_SUBAGENT_DESCRIPTION = "Set this to true if you are waiting for subagent(s) to complete. Remember you should NOT be doing this and instead end your turn or do parallel work.";
const WAITING_FOR_SUBAGENT_ERROR = "You should NOT wait for subagents to complete. End your turn instead; completions are queued, or do parallel work.";
const WAKE_REASON_CONTEXT_INJECTION = "context_injection";

type AwaitResourceAccessor = ResourceAccessor<RemoteExecManager>;

interface AwaitOptions {
  readonly toolName?: string;
  readonly toolIdentifier?: string;
  readonly terminalsFolder?: string | (() => string);
  readonly agentTranscriptsFolder?: string;
  readonly enableSubagentAwaiting?: boolean;
  readonly enableAwaitForSubagents?: boolean;
  readonly useTrainingShellOnlyPrompt?: boolean;
  readonly fixClaudeSubagentAwait?: boolean;
  readonly enableBoundedSubagentAwait?: boolean;
  readonly enableJobCompletionNotifications?: boolean;
  readonly promptCacheTTLMs?: number;
  readonly enableAwaitTerminalPathCompat?: boolean;
  readonly defaultBlockUntilMs?: number;
  readonly requireBlockUntilMs?: boolean;
  readonly defaultSubagentType?: string;
  readonly defaultModelId?: string;
}

interface AwaitExecutionMeta {
  readonly toolCallId: string;
  readonly contextInjectionSignal?: {
    hasPendingUserInjections(): boolean;
    onUserInjectionAdmitted(listener: () => void): () => void;
  };
}

interface AwaitInteractionHandler {
  executeToolCall(
    ctx: Context,
    toolCall: ToolCall,
    callId: string,
    execute: (ctx: Context) => Promise<AwaitResult>,
    merge: (result: AwaitResult) => ToolCall,
  ): Promise<AwaitResult>;
}

function createAwaitToolCall(value: AwaitToolCall): ToolCall {
  return new ToolCall({ tool: { case: "awaitToolCall", value } });
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function normalizeTaskId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length === 0 || trimmed.toLowerCase() === "none" ? "" : trimmed;
}

function isShellTaskId(taskId: string): boolean {
  return /^[0-9]+$/.test(taskId);
}

function resolveTerminalsFolder(value: string | (() => string) | undefined): string {
  return typeof value === "function" ? value() : value ?? "";
}

function joinPath(base: string, leaf: string): string {
  return `${base.endsWith("/") ? base.slice(0, -1) : base}/${leaf}`;
}

function throwIfAborted(ctx: Context): void {
  if (ctx.signal.aborted) throw new ToolCallAbortedError();
}

function sleepOrAbort(ctx: Context, milliseconds: number, signal: AwaitExecutionMeta["contextInjectionSignal"]): Promise<"timeout" | "steer_release"> {
  throwIfAborted(ctx);
  if (signal?.hasPendingUserInjections()) return Promise.resolve("steer_release");
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      ctx.signal.removeEventListener("abort", onAbort);
      unsubscribe?.();
    };
    const onAbort = () => {
      cleanup();
      reject(new ToolCallAbortedError());
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      resolve("timeout");
    }, milliseconds);
    unsubscribe = signal?.onUserInjectionAdmitted(() => {
      cleanup();
      resolve("steer_release");
    });
  });
}

function parseFooter(content: string): { isComplete: boolean; runtimeMs?: number; exitCode?: number } {
  const match = content.match(/\n---\n([\s\S]*?)\n---\s*$/);
  if (match === null) return { isComplete: false };
  const footer = match[1] ?? "";
  const exit = footer.match(/(?:^|\n)exit_code:\s*([^\n]*)/)?.[1]?.trim() ?? "";
  const parsedExit = Number(exit);
  const elapsed = footer.match(/(?:^|\n)elapsed_ms:\s*(\d+)/)?.[1];
  return {
    isComplete: true,
    ...(elapsed === undefined ? {} : { runtimeMs: Number(elapsed) }),
    ...(exit.length > 0 && Number.isInteger(parsedExit) ? { exitCode: parsedExit } : {}),
  };
}

function parseRunningForMs(content: string): number | undefined {
  const match = content.match(/^---\r?\n[\s\S]*?(?:^|\r?\n)running_for_ms:\s*(\d+)[\s\S]*?\r?\n---/m);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function bodyWithoutMetadata(content: string): string {
  let body = content;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end >= 0) body = body.slice(end + 5);
  }
  const footer = body.match(/\n---\n[\s\S]*?\n---\s*$/);
  return footer?.index === undefined ? body : body.slice(0, footer.index);
}

function regexMatcher(pattern: string | undefined): { matched(content: string): { matched: boolean; firstMatch: string } } | undefined {
  if (pattern === undefined || pattern.trim().length === 0) return undefined;
  const compiled = RE2JS.compile(pattern, RE2JS.MULTILINE);
  return {
    matched(content) {
      const matcher = compiled.matcher(content);
      if (!matcher.find()) return { matched: false, firstMatch: "" };
      return { matched: true, firstMatch: matcher.group() ?? "" };
    },
  };
}

interface ReadSnapshot { readonly exists: boolean; readonly content: string; readonly outputLength: number }

async function readSnapshot(ctx: Context, resourceAccessor: AwaitResourceAccessor, path: string, toolCallId: string): Promise<ReadSnapshot> {
  const result = await resourceAccessor.get(readExecutorResource).execute(ctx, new ReadArgs({ path, toolCallId }));
  switch (result.result.case) {
    case "success": {
      const output = result.result.value.output;
      const content = output.case === "content" ? output.value : output.case === "data" ? Buffer.from(output.value).toString("utf8") : "";
      const outputLength = Number(result.result.value.fileSize);
      return { exists: true, content, outputLength: Number.isFinite(outputLength) && outputLength > 0 ? outputLength : content.length };
    }
    case "fileNotFound": return { exists: false, content: "", outputLength: 0 };
    case "permissionDenied": throw new Error(`Permission denied reading ${path}`);
    case "rejected": throw new Error(result.result.value.reason || `Read rejected for ${path}`);
    case "invalidFile": throw new Error(result.result.value.reason || `Invalid file: ${path}`);
    case "error": throw new Error(result.result.value.error || `Read failed for ${path}`);
    case undefined: throw new Error(`Unknown read result for ${path}`);
  }
}

function findTranscript(root: { absPath: string; childrenFiles: readonly { name: string }[]; childrenDirs: readonly { absPath: string; childrenFiles: readonly { name: string }[]; childrenDirs: readonly unknown[] }[] } | undefined, name: string): string | undefined {
  if (root === undefined) return undefined;
  const stack: Array<typeof root> = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const file = node.childrenFiles.find(candidate => candidate.name === name);
    if (file !== undefined) return joinPath(node.absPath, file.name);
    for (const child of node.childrenDirs) stack.push(child as typeof root);
  }
  return undefined;
}

async function locateTranscript(ctx: Context, resourceAccessor: AwaitResourceAccessor, taskId: string, folder: string | undefined, toolCallId: string, parentConversationId: string | undefined): Promise<string | undefined> {
  if (folder === undefined || folder.length === 0) return undefined;
  const candidates = [joinPath(folder, `${taskId}.jsonl`), joinPath(folder, `${taskId}/${taskId}.jsonl`), ...(parentConversationId === undefined ? [] : [joinPath(folder, `${parentConversationId}/subagents/${taskId}.jsonl`)])];
  for (const candidate of candidates) {
    if ((await readSnapshot(ctx, resourceAccessor, candidate, toolCallId).catch(() => undefined))?.exists === true) return candidate;
  }
  const listed = await resourceAccessor.get(lsExecutorResource).execute(ctx, new LsArgs({ path: folder, toolCallId, timeoutMs: 2_000 })).catch(() => undefined);
  const tree = listed?.result.case === "success" || listed?.result.case === "timeout" ? listed.result.value.directoryTreeRoot : undefined;
  return findTranscript(tree, `${taskId}.jsonl`);
}

function normalizeResult(result: AwaitResult["result"]): AwaitResult["result"] {
  if (result.case === "success") return result.value.awaitResult?.case === undefined ? { case: undefined } : result.value.awaitResult;
  if (result.case === "error") return result;
  return { case: undefined };
}

function preprocessLenientNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  const number = Number(trimmed);
  return Number.isNaN(number) ? value : number;
}

function lenientNumber() {
  return z.preprocess(preprocessLenientNumber, z.number());
}

function buildParameters(options: { enableSubagentAwaiting: boolean; defaultBlockUntilMs: number; requireBlockUntilMs: boolean; training: boolean; includeWaitingSignal: boolean }) {
  const blockDescription = options.requireBlockUntilMs ? `Max sleep time to block before returning (in milliseconds). Required. Set to 0 for non-blocking status check.` : `Max sleep time to block before returning (in milliseconds). Defaults to ${options.defaultBlockUntilMs}ms. Set to 0 for non-blocking status check.`;
  const block = (options.requireBlockUntilMs ? lenientNumber() : lenientNumber().optional()).describe(blockDescription);
  const idNoun = options.enableSubagentAwaiting && !options.training ? "shell or subagent" : "shell";
  const id = z.preprocess(value => typeof value === "number" ? String(value) : value, z.string().optional()).describe(`Optional ${idNoun} id to poll. If omitted, this tool sleeps for the full block_until_ms duration and then returns. Required when block_until_ms is 0.`);
  const pattern = z.string().optional().describe(options.enableSubagentAwaiting
    ? "Block until the regex matches stdout/stderr stream (or task completes). Matches anywhere in the shell output, not just new output. Will not match terminal file headers or footers, e.g. exit_code. Accepts JavaScript regex patterns (compiled with the multiline `m` flag). Not supported for awaiting subagents: you MUST leave this argument unset."
    : "Block until the regex matches stdout/stderr stream (or task completes). Matches anywhere in the shell output, not just new output. Will not match terminal file headers or footers, e.g. exit_code. Accepts JavaScript regex patterns (compiled with the multiline `m` flag).");
  if (!options.enableSubagentAwaiting && !options.training) {
    return z.preprocess(raw => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const normalized = { ...(raw as Record<string, unknown>) };
      if (normalized.shell_id === undefined && normalized.task_id !== undefined) normalized.shell_id = normalized.task_id;
      return normalized;
    }, z.object({ shell_id: id, block_until_ms: block, pattern, ...(options.includeWaitingSignal ? { waiting_for_subagent: z.boolean().optional().describe(WAITING_FOR_SUBAGENT_DESCRIPTION) } : {}) }).transform(({ shell_id, ...rest }) => ({ task_id: shell_id, ...rest })));
  }
  return z.object({ task_id: id, block_until_ms: block, pattern });
}

function normalizeInput(raw: unknown, compat: boolean): unknown {
  if (!compat || raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = { ...(raw as Record<string, unknown>) };
  if (value.task_id !== undefined || value.shell_id !== undefined) return value;
  if (typeof value.path !== "string") throw new Error("path must be a path to a terminal file");
  const terminal = extractTerminalId(value.path);
  if (terminal === null) throw new Error("path must be a path to a terminal file");
  value.task_id = String(terminal.id);
  return value;
}

function formatHoursForPrompt(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}` : hours.toFixed(1);
}

function formatPromptCacheTTLWaitGuidance(milliseconds: number): string {
  const ttlSeconds = Math.round(milliseconds / 1_000);
  const ttlMinutes = Math.round(ttlSeconds / 60);
  if (ttlMinutes === 1) return `When waiting further, avoid round 1-minute waits: prefer slices of up to ${ttlSeconds - 30}s (keeps prompt cache warm) or ${ttlSeconds * 4}s+ (one cache miss buys a long wait).`;
  if (ttlMinutes >= 1 && ttlMinutes <= 30) return `When waiting further, avoid round ${ttlMinutes}-minute waits: prefer slices of 60–${ttlSeconds - 30}s (keeps prompt cache warm) or ${ttlSeconds * 4}s+ (one cache miss buys a long wait).`;
  if (ttlMinutes <= 6 * 60) return `When waiting further, avoid waiting ${formatHoursForPrompt(ttlMinutes)}h or more: prefer slices of 60s-${ttlMinutes - 1}m (keeps prompt cache warm). Size slices based on expected progress; when progress is unclear, exponential backoff is useful.`;
  return "When waiting further, size slices based on expected progress. When progress is unclear, exponential backoff is useful.";
}

function buildLegacyAwaitDescription(options: { enableSubagentAwaiting: boolean; hasShell: boolean }): string {
  const idNoun = options.enableSubagentAwaiting ? "task id" : "shell id";
  const idArg = options.enableSubagentAwaiting ? "task_id" : "shell_id";
  const shellOnlyGuidance = options.hasShell ? `
- Shell only guidance:
  - Waiting until a regex matches the output can be useful for e.g. known startup/status/error logs.
  - HARD STOPPING CONSTRAINT: Don't stop polling until (a) job terminates, (b) the command reaches a healthy steady state (only for non-terminating command, e.g. dev server/watcher), or (c) command is hung - follow guidance below.
  - Output file header has \`pid\` and \`running_for_ms\` (updated every 5000ms).
  - When finished, footer with \`exit_code\` and \`elapsed_ms\` appears (regex only matches the body, not header/footer).
  - If taking longer than expected and the command seems like it is hung (use judgment based on type of command), kill the process if safe to do so using the pid that appears in the header. If possible, try to fix the hang and proceed.` : "";
  return `Poll a background ${options.enableSubagentAwaiting ? "shell or subagent" : "shell"} job. For work that does not have a ${idNoun}, you can omit the ${idArg} arg to sleep for the full \`block_until_ms\` duration (prefer this over sleeping in the shell, because it renders nicely to the user).

Monitor backgrounded jobs as follows:
- Never poll a task whose tool result says it was "manually backgrounded by the user".
- When you spawn a command directly into the background (\`block_until_ms: 0\`), check status immediately by reading the output file to confirm the command didn't fail to start.
- Poll repeatedly to monitor by using this tool between checks (set \`block_until_ms\` to control how long to wait). If the file gets large, read from the end of the file to capture the latest content.
- Pick your polling intervals using best guess/judgment based on any knowledge you have about the command and its expected runtime, and any output from monitoring the job. When no new output, exponential backoff is useful, e.g. 2000ms, 4000ms, 8000ms, 16000ms...${shellOnlyGuidance}`;
}

function buildNotifyFirstAwaitDescription(options: { enableSubagentAwaiting: boolean; hasShell: boolean; toolName: string; taskToolName?: string; promptCacheTTLMs?: number }): string {
  const jobNoun = options.enableSubagentAwaiting ? "shell or subagent" : "shell";
  const idNoun = options.enableSubagentAwaiting ? "task id" : "shell id";
  const idArg = options.enableSubagentAwaiting ? "task_id" : "shell_id";
  const promptCacheGuidance = options.promptCacheTTLMs === undefined ? "When waiting further, avoid round 5-minute waits: prefer slices of 60–270s (keeps prompt cache warm) or 1200s+ (one cache miss buys a long wait)." : formatPromptCacheTTLWaitGuidance(options.promptCacheTTLMs);
  const neverPollSubagent = options.taskToolName !== undefined && !options.enableSubagentAwaiting ? `
- NEVER USE THIS TO POLL OR WAIT VACUOUSLY FOR A SUBAGENT LAUNCHED WITH THE ${options.taskToolName} TOOL — rely on the end-of-turn completion notification instead (it is delivered as soon as the subagent finishes; guessing a wait time is inefficient).` : "";
  const subagentRule = options.enableSubagentAwaiting ? `
- Subagents: never wait on a subagent with ${options.toolName}. Subagents are always notify-on-completion — multitask on independent work (or respond to the user if there is nothing else productive to do) and wait to be woken up. The only valid use of ${options.toolName} on a subagent is a non-blocking status check (\`block_until_ms: 0\`); never use it to block on the subagent finishing.` : "";
  const shellGuidance = options.hasShell ? `
- Shell: only poll with ${options.toolName} when the command requires close monitoring. Close monitoring means a long-running job that can silently hang, degrade, or need a course correction before it completes — e.g. training runs, eval runs, deployments, long builds, datagen pipelines, DB migrations, large data transfers. For fire-and-forget commands (tests, installs, dev servers/watchers, short scripts, etc.) the completion notification is enough — start them, keep working, and only poll with ${options.toolName} later if you end up blocked on the result.
- Shell sanity check (regardless of close monitoring): when you spawn a command directly into the background (\`block_until_ms: 0\`), do a single status check by reading the output file to confirm the command didn't fail to start. This is a one-shot smoke check, not a polling loop.
- Shell close-monitoring guidance:
  - HARD STOPPING CONSTRAINT: once you've decided to actively poll, don't stop until (a) the job terminates, (b) the command reaches a healthy steady state (only for non-terminating commands, e.g. dev server/watcher), or (c) the command is hung — follow the hang guidance below.
  - Waiting until a regex matches the output can be useful for e.g. known startup/status/error logs.
  - Size \`block_until_ms\` to the command's expected runtime. ${promptCacheGuidance}
  - Output file header has \`pid\` and \`running_for_ms\` (updated every 5000ms).
  - When finished, footer with \`exit_code\` and \`elapsed_ms\` appears (regex only matches the body, not header/footer).
  - If the command is taking longer than expected and appears hung, kill it if safe using the pid in the header. If possible, fix the hang and proceed.` : "";
  const blockedScope = options.enableSubagentAwaiting ? " (shell jobs only — never wait on a subagent)" : "";
  const closeMonitoringClause = options.enableSubagentAwaiting ? " Subagents are never a candidate for close monitoring." : "";
  const positivePollBlock = options.hasShell ? `

Prefer NOT to poll reflexively with ${options.toolName}. Multitask on independent work while backgrounded jobs run, or finish your turn and rely on the end-of-turn completion notification. Poll with ${options.toolName} only when one of the following is true:
- Your very next step is blocked on this specific job's result and you have no other productive work to do${blockedScope}, OR
- The task requires close monitoring (see shell guidance below).${closeMonitoringClause}` : `

Prefer NOT to poll reflexively with ${options.toolName}. Multitask on independent work while backgrounded jobs run, or finish your turn and rely on the end-of-turn completion notification.`;
  return `Check or poll a backgrounded ${jobNoun} job. For work that does not have a ${idNoun}, you can omit the ${idArg} arg to sleep for the full \`block_until_ms\` duration (prefer this over sleeping in the shell, because it renders nicely to the user). At the end of your turn, you will be notified about any unawaited jobs that completed. If you think a job completed (e.g. because you killed it), observe it with ${options.toolName} to skip the notification, because stale notifications can confuse the user.${positivePollBlock}
- Never poll a task whose tool result says it was "manually backgrounded by the user".${neverPollSubagent}${subagentRule}${shellGuidance}`;
}

export type AwaitToolResourceAccessor = AwaitResourceAccessor;
export interface AwaitToolOptions extends AwaitOptions {}

export function createAwaitTool(resourceAccessor: AwaitResourceAccessor, options: AwaitToolOptions, promptVersion = "latest") {
  const training = options.useTrainingShellOnlyPrompt === true;
  const enableSubagentAwaiting = options.enableSubagentAwaiting === true && options.enableAwaitForSubagents !== false && !training;
  const derivedName = !enableSubagentAwaiting && !training ? AWAIT_TOOL_MODEL_NAME_SHELL_ONLY : AWAIT_TOOL_MODEL_NAME_DEFAULT;
  const name = options.toolName ?? derivedName;
  const includeWaitingSignal = options.fixClaudeSubagentAwait === true && derivedName === AWAIT_TOOL_MODEL_NAME_SHELL_ONLY;
  const defaultBlockUntilMs = options.defaultBlockUntilMs ?? DEFAULT_BLOCK_UNTIL_MS;
  const parameters = buildParameters({ enableSubagentAwaiting, defaultBlockUntilMs, requireBlockUntilMs: options.requireBlockUntilMs === true, training, includeWaitingSignal });
  const parsing = z.preprocess(raw => normalizeInput(raw, options.enableAwaitTerminalPathCompat === true), parameters);

  const execute = async (parent: Context, interactionHandler: AwaitInteractionHandler, raw: { task_id?: string; shell_id?: string; block_until_ms?: number; pattern?: string; waiting_for_subagent?: boolean }, meta: AwaitExecutionMeta): Promise<AwaitResult> => {
    using span = createSpan(parent.withName("awaitExecute"));
    const ctx = span.ctx;
    const taskId = normalizeTaskId(raw.task_id ?? raw.shell_id);
    const blockUntilMs = toPositiveInt(raw.block_until_ms, defaultBlockUntilMs);
    const baseCall = new AwaitToolCall({ args: new AwaitArgs({ taskId, blockUntilMs, ...(raw.pattern === undefined ? {} : { regex: raw.pattern }) }) });
    return interactionHandler.executeToolCall(ctx, createAwaitToolCall(baseCall), meta.toolCallId, async toolCtx => {
      if (includeWaitingSignal && raw.waiting_for_subagent === true) throw new ToolCallArgParseError(WAITING_FOR_SUBAGENT_ERROR);
      const startMs = Date.now();
      if (taskId.length === 0) {
        if (blockUntilMs === 0) throw new Error("Must pass a task id or wait for a nonzero duration.");
        const outcome = await sleepOrAbort(toolCtx, blockUntilMs, meta.contextInjectionSignal);
        return new AwaitResult({ result: { case: "success", value: new AwaitSuccess({ awaitResult: { case: "complete", value: new AwaitTaskComplete({ taskId: "", runtimeMs: BigInt(Date.now() - startMs), outputFilePath: "", outputLength: 0n, regexRequested: false, ...(outcome === "steer_release" ? { wakeReason: WAKE_REASON_CONTEXT_INJECTION } : {}) }) } }) } });
      }
      const regexRequested = typeof raw.pattern === "string" && raw.pattern.trim().length > 0;
      const matcher = regexMatcher(raw.pattern);
      if (!isShellTaskId(taskId)) {
        if (!enableSubagentAwaiting) throw new ToolCallArgParseError(WAITING_FOR_SUBAGENT_ERROR);
        if (regexRequested) throw new ToolCallArgParseError("Regex awaiting is not available for subagents. Run Await without regex, or await a shell task id instead.");
        const parentConversationId = getConversationId(toolCtx);
        if (!parentConversationId) throw new Error("Awaiting subagent tasks requires a non-empty conversationId in the agent context");
        const result = options.enableBoundedSubagentAwait === true
          ? await resourceAccessor.get(subagentAwaitExecutorResource).execute(toolCtx, new SubagentAwaitArgs({ agentId: taskId, timeoutMs: blockUntilMs }))
          : await resourceAccessor.get(subagentExecutorResource).execute(toolCtx, new SubagentArgs({ toolCallId: meta.toolCallId, resumeAgentId: taskId, parentConversationId, prompt: "", readonly: true, runInBackground: false, subagentType: options.defaultSubagentType ?? "generalPurpose", modelId: options.defaultModelId ?? "default-model" }));
        if ("result" in result && result.result.case === "complete") {
          const complete = result.result.value;
          const transcriptPath = "transcriptPath" in complete ? complete.transcriptPath : await locateTranscript(toolCtx, resourceAccessor, taskId, options.agentTranscriptsFolder, meta.toolCallId, parentConversationId);
          const snapshot = transcriptPath === undefined ? undefined : await readSnapshot(toolCtx, resourceAccessor, transcriptPath, meta.toolCallId).catch(() => undefined);
          return new AwaitResult({ result: { case: "success", value: new AwaitSuccess({ awaitResult: { case: "complete", value: new AwaitTaskComplete({ taskId, runtimeMs: BigInt(Date.now() - startMs), outputFilePath: transcriptPath ?? "", outputLength: BigInt(snapshot?.outputLength ?? 0) }) } }) } });
        }
        throw new Error("Failed to await subagent task");
      }
      const terminalsFolder = resolveTerminalsFolder(options.terminalsFolder);
      if (!terminalsFolder) throw new Error("Cannot await shell task: terminals folder is unavailable");
      const outputPath = joinPath(terminalsFolder, `${taskId}.txt`);
      const deadline = Date.now() + blockUntilMs;
      let steerReleasedMidSleep = false;
      while (true) {
        throwIfAborted(toolCtx);
        const snapshot = await readSnapshot(toolCtx, resourceAccessor, outputPath, meta.toolCallId);
        if (!snapshot.exists) throw new Error(`No shell found for id ${taskId}`);
        const footer = parseFooter(snapshot.content);
        const runtimeMs = footer.runtimeMs ?? parseRunningForMs(snapshot.content) ?? Math.max(0, Date.now() - startMs);
        const found = matcher?.matched(bodyWithoutMetadata(snapshot.content));
        const regexMatch = regexRequested && found?.matched === true ? found.firstMatch.slice(0, 500) : undefined;
        const steerReleased = steerReleasedMidSleep || meta.contextInjectionSignal?.hasPendingUserInjections() === true;
        const result = footer.isComplete ? "complete" : blockUntilMs === 0 || Date.now() >= deadline || steerReleased ? "stillRunning" : undefined;
        if (result !== undefined) {
          const value = result === "complete" ? new AwaitTaskComplete({ taskId, runtimeMs: BigInt(runtimeMs), outputFilePath: outputPath, outputLength: BigInt(snapshot.outputLength), regexRequested, ...(regexMatch === undefined ? {} : { regexMatch }), ...(footer.exitCode === undefined ? {} : { exitCode: footer.exitCode }) }) : new AwaitTaskStillRunning({ taskId, runtimeMs: BigInt(runtimeMs), outputFilePath: outputPath, outputLength: BigInt(snapshot.outputLength), regexRequested, ...(regexMatch === undefined ? {} : { regexMatch }), ...(steerReleased ? { wakeReason: WAKE_REASON_CONTEXT_INJECTION } : {}) });
          return new AwaitResult({ result: { case: "success", value: new AwaitSuccess({ awaitResult: { case: result, value } }) } });
        }
        if (found?.matched === true) return new AwaitResult({ result: { case: "success", value: new AwaitSuccess({ awaitResult: { case: "stillRunning", value: new AwaitTaskStillRunning({ taskId, runtimeMs: BigInt(runtimeMs), outputFilePath: outputPath, outputLength: BigInt(snapshot.outputLength), regexRequested, regexMatch: found.firstMatch.slice(0, 500) }) } }) } });
        if (await sleepOrAbort(toolCtx, SHELL_CHECK_SLICE_MS, meta.contextInjectionSignal) === "steer_release") steerReleasedMidSleep = true;
      }
    }, result => createAwaitToolCall(new AwaitToolCall({ ...baseCall, result })));
  };

  return createZodAgentTool(options.toolIdentifier ?? "AWAIT", {
    name,
    contextType: { type: "dynamic", conciseStaticContext: "Use to sleep and check shell progress. Never sleep using shell." },
    descriptionGenerator: (props: { allTools: Record<string, { name?: string }> }) => {
      const shellToolName = props.allTools.SHELL?.name;
      const taskToolName = props.allTools.TASK?.name;
      const mentionSubagents = enableSubagentAwaiting && taskToolName !== undefined;
      if (training) return "Poll a background shell.";
      if (!["cursor-0226", "dsv3-1205", "dsv3-1018", "gpt5-codex", "codex-cloud", "latest", "haiku"].includes(promptVersion)) throw new Error(`Unhandled version: ${promptVersion}`);
      return options.enableJobCompletionNotifications === true
        ? buildNotifyFirstAwaitDescription({ enableSubagentAwaiting: mentionSubagents, hasShell: shellToolName !== undefined, toolName: name, ...(taskToolName === undefined ? {} : { taskToolName }), ...(options.promptCacheTTLMs === undefined ? {} : { promptCacheTTLMs: options.promptCacheTTLMs }) })
        : buildLegacyAwaitDescription({ enableSubagentAwaiting: mentionSubagents, hasShell: shellToolName !== undefined });
    },
    parameters,
    execute: withSafeParsedArgs(parsing, execute, createAwaitToolCall(new AwaitToolCall())),
    render: async (_ctx: Context, output: AwaitResult) => {
      const normalized = normalizeResult(output.result);
      if (normalized.case === "complete") {
        const value = normalized.value;
        if (!value.taskId) return createStringResult(value.wakeReason === WAKE_REASON_CONTEXT_INJECTION ? "Slept briefly. Sleep released early: a new user message is arriving." : "Slept briefly.");
        return createStringResult(`Task completed in ${value.runtimeMs.toString()}ms with exit code: ${value.exitCode ?? "unknown"}.\noutput_file_path: ${value.outputFilePath}\noutput_length: ${value.outputLength.toString()}`);
      }
      if (normalized.case === "stillRunning") return createStringResult(`Task still running after ${normalized.value.runtimeMs.toString()}ms...\noutput_file_path: ${normalized.value.outputFilePath}\noutput_length: ${normalized.value.outputLength.toString()}`);
      if (normalized.case === "error") return createStringResult(`Error awaiting task: ${normalized.value.error}`);
      return createStringResult("Unknown error");
    },
    serializeError: error => createAwaitToolCall(new AwaitToolCall({ result: new AwaitResult({ result: { case: "error", value: new AwaitError({ error: error instanceof Error ? error.message : String(error) }) } }) })),
  });
}
