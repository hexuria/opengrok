import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RE2JS } from "re2js";

import { LEGACY_LOCAL_WAKEUP_CONVERSATION_ID } from "../agent-exec/background-work-registry.js";
import {
  type BackgroundAdoptState,
  type BackgroundSpawnContext,
  type BackgroundShell,
  type BackgroundShellFactory,
  type BackgroundWorkRegistry,
} from "./background-shell-lifecycle.js";
import type { ShellCoreEvent } from "./shell-core.js";
import { type Context } from "../context/core.js";
import { createLogger } from "../context/logger.js";

const logger = createLogger("local-exec:background-shell");
const OUTPUT_NOTIFICATION_LIMIT = 100;
const OUTPUT_NOTIFICATION_MIN_DEBOUNCE_MS = 5_000;
const OUTPUT_NOTIFICATION_DEBOUNCE_MS = OUTPUT_NOTIFICATION_MIN_DEBOUNCE_MS;
const OUTPUT_NOTIFICATION_CARRYOVER_CHARS = 1_024;
const MAX_NOTIFICATION_TEXT_CHARS = 500;
const MAX_OUTPUT_NOTIFICATION_MATCHED_TEXT_CHARS = 5_000;
const MAX_OUTPUT_NOTIFICATION_PATTERN_CHARS = 500;
const MAX_OUTPUT_NOTIFICATION_SCAN_CHARS = 64 * 1024;
const RUNNING_TIME_UPDATE_INTERVAL_MS = 5_000;
const RUNNING_MS_WIDTH = 9;
const TERMINAL_TASK_STATUS_WIDTH = 9;

interface OutputNotificationConfig {
  readonly pattern: string;
  readonly reason: string;
  readonly notificationLimit?: number | undefined;
  readonly debounce?: number | undefined;
}

interface NotificationArguments {
  readonly shellId: number;
  readonly outputPath: string;
  readonly config: OutputNotificationConfig;
  readonly conversationId: string;
  readonly toolCallId?: string | undefined;
  readonly debounceMs?: number | undefined;
  readonly registry: Pick<BackgroundWorkRegistry, "enqueue">;
}

type ShellEvent = ShellCoreEvent;

interface ShellArguments {
  readonly signal?: AbortSignal | undefined;
  readonly showElapsedTime?: boolean | undefined;
}

interface ShellExecutionContext {
  readonly ctx?: Context | undefined;
  readonly shellId: number;
  readonly conversationId?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly outputNotification?: unknown;
  readonly command: string;
  readonly workingDirectory: string;
  readonly description?: string | undefined;
}

interface LoggingExecutionContext extends ShellExecutionContext {
  readonly shellId: number;
}

interface CoreExecutor {
  execute(ctx: unknown, args: ShellArguments): AsyncIterable<ShellEvent>;
}

interface EventIterator {
  next(): Promise<IteratorResult<ShellEvent>>;
  return?(value?: unknown): Promise<IteratorResult<ShellEvent>>;
}

interface LoggedStdin {
  write(...args: unknown[]): unknown;
  end(...args: unknown[]): unknown;
}

function isOutputNotificationConfig(value: unknown): value is OutputNotificationConfig {
  return typeof value === "object" && value !== null && "pattern" in value && typeof value.pattern === "string" && "reason" in value && typeof value.reason === "string";
}

function getConfiguredOutputNotificationDebounceMs(config: OutputNotificationConfig): number | undefined {
  const debounceSeconds = config.debounce;
  if (debounceSeconds === undefined || !Number.isFinite(debounceSeconds)) return undefined;
  return Math.ceil(debounceSeconds * 1_000);
}

function truncateNotificationText(value: string): string {
  return value.length <= MAX_NOTIFICATION_TEXT_CHARS ? value : `${value.slice(0, MAX_NOTIFICATION_TEXT_CHARS)}...`;
}

function formatMatchedTextDetail(matchedText: string, label: string): string {
  return matchedText.length <= MAX_OUTPUT_NOTIFICATION_MATCHED_TEXT_CHARS
    ? `${label}: ${matchedText}`
    : `${label} is ${matchedText.length} characters; omitted from notification detail.`;
}

export class ShellOutputNotificationObserver {
  private readonly args: NotificationArguments;
  private carryover = "";
  private matchedOccurrences = 0;
  private emittedNotifications = 0;
  private finished = false;
  private readonly limit: number;
  private readonly regex: RE2JS;
  private pendingBatch: {
    startOccurrence: number;
    endOccurrence: number;
    count: number;
    matchedTextDetail: string;
  } | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(args: NotificationArguments) {
    this.args = args;
    this.limit = args.config.notificationLimit ?? OUTPUT_NOTIFICATION_LIMIT;
    if (args.config.pattern.length > MAX_OUTPUT_NOTIFICATION_PATTERN_CHARS) {
      throw new Error(`Output notification pattern exceeds ${MAX_OUTPUT_NOTIFICATION_PATTERN_CHARS} characters`);
    }
    this.regex = RE2JS.compile(args.config.pattern, RE2JS.MULTILINE);
  }

  observe(data: string): void {
    if (this.finished || this.matchedOccurrences >= this.limit || data.length === 0) return;
    if (data.length > MAX_OUTPUT_NOTIFICATION_SCAN_CHARS) {
      for (let offset = 0; offset < data.length && this.matchedOccurrences < this.limit; offset += MAX_OUTPUT_NOTIFICATION_SCAN_CHARS) {
        this.observe(data.slice(offset, offset + MAX_OUTPUT_NOTIFICATION_SCAN_CHARS));
      }
      return;
    }
    const previousLength = this.carryover.length;
    const searchable = `${this.carryover}${data}`;
    const matcher = this.regex.matcher(searchable);
    while (this.matchedOccurrences < this.limit && matcher.find()) {
      const matchedText = matcher.group() ?? "";
      if (matcher.end() > previousLength) this.queueMatch(matchedText);
    }
    this.carryover = searchable.slice(-OUTPUT_NOTIFICATION_CARRYOVER_CHARS);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.flushPendingBatch("finish");
    this.clearFlushTimer();
  }

  private queueMatch(matchedText: string): void {
    if (this.matchedOccurrences >= this.limit) return;
    this.matchedOccurrences += 1;
    const occurrence = this.matchedOccurrences;
    const matchedTextDetail = formatMatchedTextDetail(matchedText, occurrence === 1 ? "Matched text" : "Latest match");
    if (occurrence === 1) {
      this.emitNotification({ startOccurrence: occurrence, endOccurrence: occurrence, count: 1, matchedTextDetail });
      if (occurrence === this.limit) this.emitLimitReachedNotification();
      return;
    }
    if (!this.pendingBatch) {
      this.pendingBatch = { startOccurrence: occurrence, endOccurrence: occurrence, count: 1, matchedTextDetail };
    } else {
      this.pendingBatch.endOccurrence = occurrence;
      this.pendingBatch.count += 1;
      this.pendingBatch.matchedTextDetail = matchedTextDetail;
    }
    if (occurrence === this.limit) {
      this.flushPendingBatch("limit");
      this.emitLimitReachedNotification();
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    const debounceMs = this.getDebounceMs();
    this.flushTimer = setTimeout(() => this.flushPendingBatch("debounce"), debounceMs);
  }

  private getDebounceMs(): number {
    const debounceMs = this.args.debounceMs ?? getConfiguredOutputNotificationDebounceMs(this.args.config) ?? OUTPUT_NOTIFICATION_DEBOUNCE_MS;
    return Math.max(debounceMs, OUTPUT_NOTIFICATION_MIN_DEBOUNCE_MS);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private flushPendingBatch(_reason: string): void {
    const batch = this.pendingBatch;
    if (!batch) return;
    this.pendingBatch = undefined;
    this.clearFlushTimer();
    this.emitNotification(batch);
  }

  private emitNotification(batch: { startOccurrence: number; endOccurrence: number; count: number; matchedTextDetail?: string }): void {
    this.emittedNotifications += 1;
    const title = this.args.config.reason.trim() || `Shell output contains /${this.args.config.pattern}/`;
    const pattern = this.args.config.pattern;
    const matchedTextSentence = batch.matchedTextDetail !== undefined ? ` ${batch.matchedTextDetail}.` : "";
    const detail = batch.count === 1
      ? `Shell output has pattern /${pattern}/. This is occurrence number ${batch.startOccurrence}.${matchedTextSentence} The title message is being displayed to the user.`
      : `Shell output matched /${pattern}/ ${batch.count} more times since the previous notification. The title message is being displayed to the user.${matchedTextSentence}`;
    const taskId = `${this.args.shellId}:task_progress:${this.emittedNotifications}`;
    this.args.registry.enqueue({
      conversationId: this.args.conversationId,
      id: taskId,
      source: "shell",
      payload: {
        taskId,
        ...(this.args.toolCallId === undefined ? {} : { toolCallId: this.args.toolCallId }),
        kind: "shell",
        status: "success",
        title: truncateNotificationText(title),
        detail,
        outputPath: this.args.outputPath,
        reason: "task_progress",
      },
    });
  }

  private emitLimitReachedNotification(): void {
    this.emittedNotifications += 1;
    const pattern = this.args.config.pattern;
    const taskId = `${this.args.shellId}:task_progress:${this.emittedNotifications}`;
    this.args.registry.enqueue({
      conversationId: this.args.conversationId,
      id: taskId,
      source: "shell",
      payload: {
        taskId,
        ...(this.args.toolCallId === undefined ? {} : { toolCallId: this.args.toolCallId }),
        kind: "shell",
        status: "success",
        title: `Notification limit reached (${this.limit})`,
        detail: `Shell output matched /${pattern}/ ${this.limit} times and has reached the notification limit. No further notifications will be sent for this pattern. To continue monitoring, read the output file directly at the output path.`,
        outputPath: this.args.outputPath,
        reason: "task_progress",
      },
    });
  }
}

export class NotifyingBackgroundShellFactory {
  constructor(
    private readonly innerFactory: BackgroundShellFactory,
    private readonly projectDir: string,
    private readonly backgroundWorkRegistry?: BackgroundWorkRegistry,
  ) {}

  async spawn(executionContext: BackgroundSpawnContext, coreExecutor: unknown): Promise<BackgroundShell> {
    const context: ShellExecutionContext = executionContext;
    const observer = this.createObserver(context.ctx, context.shellId, context.conversationId, context.toolCallId, context.outputNotification);
    if (!observer) return this.innerFactory.spawn(executionContext, coreExecutor);
    try {
      return await this.innerFactory.spawn(executionContext, this.createObservingExecutor(coreExecutor as CoreExecutor, observer));
    } catch (error) {
      observer.finish();
      throw error;
    }
  }

  async adopt(state: BackgroundAdoptState): Promise<BackgroundShell> {
    const value: ShellExecutionContext & { readonly initialOutput: string; readonly eventIterator: EventIterator } = state;
    const observer = this.createObserver(value.ctx, value.shellId, undefined, value.toolCallId, value.outputNotification);
    if (!observer) return this.innerFactory.adopt(state);
    if (value.initialOutput.length > 0) observer.observe(value.initialOutput);
    try {
      return await this.innerFactory.adopt({ ...state, eventIterator: this.createObservingIterator(value.eventIterator, observer) });
    } catch (error) {
      observer.finish();
      throw error;
    }
  }

  private createObserver(
    ctx: Context | undefined,
    shellId: number,
    conversationId: string | undefined,
    toolCallId: string | undefined,
    config: unknown,
  ): ShellOutputNotificationObserver | undefined {
    if (!this.backgroundWorkRegistry || !isOutputNotificationConfig(config) || config.pattern.trim().length === 0) return undefined;
    const outputPath = join(this.projectDir, "terminals", `${shellId}.txt`);
    try {
      return new ShellOutputNotificationObserver({
        shellId,
        outputPath,
        config,
        conversationId: conversationId ?? LEGACY_LOCAL_WAKEUP_CONVERSATION_ID,
        toolCallId,
        registry: this.backgroundWorkRegistry,
      });
    } catch (error) {
      if (ctx !== undefined) logger.warn(ctx, "Invalid shell output notification pattern", { shellId, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  private createObservingExecutor(coreExecutor: CoreExecutor, observer: ShellOutputNotificationObserver): CoreExecutor {
    const originalExecute = coreExecutor.execute.bind(coreExecutor);
    return {
      ...coreExecutor,
      execute: async function* (ctx: unknown, args: ShellArguments): AsyncIterable<ShellEvent> {
        try {
          for await (const event of originalExecute(ctx, args)) {
            if (event.type === "stdout" || event.type === "stderr") observer.observe(event.data ?? "");
            else if (event.type === "exit") observer.finish();
            yield event;
          }
        } finally {
          observer.finish();
        }
      },
    };
  }

  private createObservingIterator(iterator: EventIterator, observer: ShellOutputNotificationObserver): EventIterator {
    const returnIterator = iterator.return?.bind(iterator);
    return {
      next: async () => {
        try {
          const result = await iterator.next();
          if (!result.done) {
            if (result.value.type === "stdout" || result.value.type === "stderr") observer.observe(result.value.data ?? "");
            else if (result.value.type === "exit") observer.finish();
          } else observer.finish();
          return result;
        } catch (error) {
          observer.finish();
          throw error;
        }
      },
      return: async (value?: unknown) => {
        observer.finish();
        return returnIterator ? returnIterator(value) : { done: true, value: undefined };
      },
    };
  }
}

function escapeYamlString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function buildFrontmatter(params: { readonly pid?: number | undefined; readonly cwd: string; readonly command: string; readonly title?: string | undefined; readonly status: string; readonly startedAt: string; readonly runningForMs: number }): string {
  const paddedMs = String(params.runningForMs).padEnd(RUNNING_MS_WIDTH, " ");
  const paddedStatus = params.status.padEnd(TERMINAL_TASK_STATUS_WIDTH, " ");
  let content = "---\n";
  if (params.pid !== undefined && params.pid !== 0) content += `pid: ${params.pid}\n`;
  content += `cwd: ${escapeYamlString(params.cwd)}\n`;
  content += `command: ${escapeYamlString(params.command)}\n`;
  if (params.title !== undefined && params.title.trim().length > 0) content += `title: ${escapeYamlString(params.title)}\n`;
  content += `status: ${paddedStatus}\n`;
  content += `started_at: ${params.startedAt}\n`;
  content += `running_for_ms: ${paddedMs}\n`;
  return `${content}---\n`;
}

export class FileLoggingShellFactory {
  constructor(private readonly innerFactory: BackgroundShellFactory, private readonly projectDir: string) {}

  async spawn(executionContext: BackgroundSpawnContext, coreExecutor: unknown): Promise<BackgroundShell> {
    const terminalsDir = join(this.projectDir, "terminals");
    await mkdir(terminalsDir, { recursive: true });
    return this.innerFactory.spawn(executionContext, this.createLoggingExecutor(coreExecutor as CoreExecutor, executionContext as unknown as LoggingExecutionContext, terminalsDir));
  }

  private createLoggingExecutor(coreExecutor: CoreExecutor, executionContext: LoggingExecutionContext, terminalsDir: string): CoreExecutor {
    const originalExecute = coreExecutor.execute.bind(coreExecutor);
    return {
      ...coreExecutor,
      execute: async function* (ctx: unknown, args: ShellArguments): AsyncIterable<ShellEvent> {
        let frontmatterHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
        let appendHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
        let stdinPatched = false;
        let headerWritten = false;
        let updateInterval: ReturnType<typeof setInterval> | undefined;
        const startTime = Date.now();
        const startedAt = new Date(startTime).toISOString();
        let currentPid: number | undefined;
        let taskStatus = "running";
        let terminalFinalized = false;
        let pendingFrontmatterUpdate: Promise<void> = Promise.resolve();
        const shellId = executionContext.shellId;
        const terminalPath = join(terminalsDir, `${shellId}.txt`);
        const safeWrite = async (data: string): Promise<void> => {
          if (!appendHandle) return;
          try { await appendHandle.write(data); } catch {}
        };
        const updateFrontmatter = async (): Promise<void> => {
          if (!frontmatterHandle) return;
          const frontmatter = buildFrontmatter({
            pid: currentPid,
            cwd: executionContext.workingDirectory,
            command: executionContext.command,
            title: executionContext.description,
            status: taskStatus,
            startedAt,
            runningForMs: Date.now() - startTime,
          });
          try { await frontmatterHandle.write(frontmatter, 0, "utf8"); } catch {}
        };
        const queueFrontmatterUpdate = (): Promise<void> => {
          pendingFrontmatterUpdate = pendingFrontmatterUpdate.then(updateFrontmatter).catch(() => {});
          return pendingFrontmatterUpdate;
        };
        const clearUpdateInterval = (): void => {
          if (updateInterval !== undefined) {
            clearInterval(updateInterval);
            updateInterval = undefined;
          }
        };
        const writeHeader = async (pid?: number): Promise<void> => {
          if (headerWritten) return;
          headerWritten = true;
          currentPid = pid;
          await writeFile(terminalPath, buildFrontmatter({ pid, cwd: executionContext.workingDirectory, command: executionContext.command, title: executionContext.description, status: taskStatus, startedAt, runningForMs: Date.now() - startTime }), "utf8");
          updateInterval = setInterval(() => { void queueFrontmatterUpdate(); }, RUNNING_TIME_UPDATE_INTERVAL_MS);
        };
        const ensureHandlesOpen = async (): Promise<void> => {
          if (!frontmatterHandle) frontmatterHandle = await fs.open(terminalPath, "r+");
          if (!appendHandle) appendHandle = await fs.open(terminalPath, "a");
        };
        const finalizeTerminal = async (status: string, firstFooterLine?: string): Promise<void> => {
          if (terminalFinalized) return;
          terminalFinalized = true;
          clearUpdateInterval();
          if (!headerWritten) await writeHeader();
          await ensureHandlesOpen();
          if (firstFooterLine !== undefined) {
            const footer = `\n---\n${firstFooterLine}\n${args.showElapsedTime ? `elapsed_ms: ${Date.now() - startTime}\n` : ""}ended_at: ${new Date().toISOString()}\n---\n`;
            await safeWrite(footer);
          }
          taskStatus = status;
          await queueFrontmatterUpdate();
        };
        try {
          for await (const event of originalExecute(ctx, args)) {
            if (event.type === "stdout" || event.type === "stderr") {
              if (!headerWritten) { await writeHeader(); await ensureHandlesOpen(); }
              await safeWrite(event.data ?? "");
            } else if (event.type === "stdin_ready" && !stdinPatched) {
              stdinPatched = true;
              if (!headerWritten) { await writeHeader(event.pid); await ensureHandlesOpen(); }
              const stdin = event.stdin;
              if (stdin) {
                const logInputChunk = (chunk: unknown): void => {
                  if (chunk === undefined || chunk === null) return;
                  const chunkString = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
                  if (chunkString) void safeWrite(`[stdin] ${chunkString.endsWith("\n") ? chunkString : `${chunkString}\n`}`);
                };
                const originalWrite = stdin.write.bind(stdin);
                stdin.write = (chunk: Uint8Array | string, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
                  logInputChunk(chunk);
                  return Reflect.apply(originalWrite, stdin, typeof encodingOrCallback === "function" ? [chunk, encodingOrCallback] : [chunk, encodingOrCallback, callback]);
                };
                const originalEnd = stdin.end;
                stdin.end = (chunkOrCallback?: Uint8Array | string | (() => void), encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void): NodeJS.WritableStream => {
                  if (typeof chunkOrCallback !== "function" && chunkOrCallback !== undefined) logInputChunk(chunkOrCallback);
                  return Reflect.apply(originalEnd, stdin, typeof chunkOrCallback === "function"
                    ? [chunkOrCallback]
                    : typeof encodingOrCallback === "function"
                      ? chunkOrCallback === undefined ? [encodingOrCallback] : [chunkOrCallback, encodingOrCallback]
                      : chunkOrCallback === undefined ? [callback] : [chunkOrCallback, encodingOrCallback, callback]);
                };
              }
            } else if (event.type === "exit") {
              await finalizeTerminal(event.aborted ? "aborted" : event.code === 0 ? "succeeded" : "failed", `exit_code: ${event.code ?? "unknown"}`);
            }
            yield event;
          }
          if (!terminalFinalized) await finalizeTerminal(args.signal?.aborted ? "aborted" : "failed");
        } catch (error) {
          const aborted = args.signal?.aborted ?? false;
          await finalizeTerminal(aborted ? "aborted" : "failed", aborted ? undefined : `error: ${escapeYamlString(error instanceof Error ? error.message : "Unknown error")}`);
          if (!aborted) throw error;
        } finally {
          clearUpdateInterval();
          await pendingFrontmatterUpdate;
          try { await frontmatterHandle?.close(); } catch {}
          try { await appendHandle?.close(); } catch {}
        }
      },
    };
  }

  async adopt(state: BackgroundAdoptState): Promise<BackgroundShell> {
    const value = state as unknown as LoggingExecutionContext & { readonly initialOutput?: string; readonly eventIterator: EventIterator; readonly startTime: number; readonly pid?: number; readonly showElapsedTime?: boolean; readonly abortController: AbortController };
    const terminalsDir = join(this.projectDir, "terminals");
    await mkdir(terminalsDir, { recursive: true });
    const terminalPath = join(terminalsDir, `${value.shellId}.txt`);
    const startTime = value.startTime;
    let taskStatus = "running";
    await writeFile(terminalPath, buildFrontmatter({ pid: value.pid, cwd: value.workingDirectory, command: value.command, title: value.description, status: taskStatus, startedAt: new Date(startTime).toISOString(), runningForMs: Date.now() - startTime }) + (value.initialOutput ?? ""), "utf8");
    const frontmatterHandle = await fs.open(terminalPath, "r+");
    let appendHandle: Awaited<ReturnType<typeof fs.open>>;
    try { appendHandle = await fs.open(terminalPath, "a"); } catch (error) { await frontmatterHandle.close(); throw error; }
    let cleanedUp = false;
    let terminalFinalized = false;
    let pendingFrontmatterUpdate: Promise<void> = Promise.resolve();
    const clearUpdateInterval = (): void => clearInterval(updateInterval);
    let updateInterval = setInterval(() => { void queueFrontmatterUpdate(); }, RUNNING_TIME_UPDATE_INTERVAL_MS);
    const updateFrontmatter = async (): Promise<void> => {
      try { await frontmatterHandle.write(buildFrontmatter({ pid: value.pid, cwd: value.workingDirectory, command: value.command, title: value.description, status: taskStatus, startedAt: new Date(startTime).toISOString(), runningForMs: Date.now() - startTime }), 0, "utf8"); } catch {}
    };
    const queueFrontmatterUpdate = (): Promise<void> => { pendingFrontmatterUpdate = pendingFrontmatterUpdate.then(updateFrontmatter).catch(() => {}); return pendingFrontmatterUpdate; };
    const cleanup = async (): Promise<void> => { if (cleanedUp) return; cleanedUp = true; clearUpdateInterval(); await pendingFrontmatterUpdate; try { await frontmatterHandle.close(); } catch {} try { await appendHandle.close(); } catch {} };
    const safeWrite = async (data: string): Promise<void> => { try { await appendHandle.write(data); } catch {} };
    const finalizeTerminal = async (status: string, firstFooterLine?: string): Promise<void> => { if (terminalFinalized) return; terminalFinalized = true; clearUpdateInterval(); if (firstFooterLine !== undefined) await safeWrite(`\n---\n${firstFooterLine}\n${value.showElapsedTime ? `elapsed_ms: ${Date.now() - startTime}\n` : ""}ended_at: ${new Date().toISOString()}\n---\n`); taskStatus = status; await queueFrontmatterUpdate(); };
    const loggingIterator: EventIterator = {
      next: async () => {
        try {
          const result = await value.eventIterator.next();
          if (!result.done) {
            if (result.value.type === "stdout" || result.value.type === "stderr") await safeWrite(result.value.data ?? "");
            else if (result.value.type === "exit") { await finalizeTerminal(result.value.aborted ? "aborted" : result.value.code === 0 ? "succeeded" : "failed", `exit_code: ${result.value.code ?? "unknown"}`); await cleanup(); }
          } else if (!terminalFinalized) await finalizeTerminal(value.abortController.signal.aborted ? "aborted" : "failed");
          if (result.done) await cleanup();
          return result;
        } catch (error) { await finalizeTerminal(value.abortController.signal.aborted ? "aborted" : "failed"); await cleanup(); throw error; }
      },
      return: async () => { if (!terminalFinalized) await finalizeTerminal(value.abortController.signal.aborted ? "aborted" : "failed"); await cleanup(); return value.eventIterator.return ? value.eventIterator.return() : { done: true, value: undefined }; },
    };
    return this.innerFactory.adopt({ ...state, eventIterator: loggingIterator });
  }
}
