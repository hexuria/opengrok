import { LEGACY_LOCAL_WAKEUP_CONVERSATION_ID } from "../agent-exec/background-work-registry.js";
import { encodeBackgroundWorkMetadata } from "../agent-exec/background-work-metadata.js";
import type { Context } from "../context/core.js";
import type { SandboxPolicy, ShellCoreEvent } from "./shell-core.js";

export interface ShellCompletion {
  readonly code: number | null;
  readonly aborted: boolean;
  readonly outputPath?: string;
}

export interface BackgroundShell {
  readonly id: number;
  readonly signal: AbortSignal;
  readonly pid?: number | undefined;
  readonly stdin?: NodeJS.WritableStream | undefined;
  abort(): void;
  dispose(): void;
  onComplete?(listener: (completion: ShellCompletion) => void): void;
}

export interface BackgroundSpawnContext {
  readonly ctx: Context;
  readonly shellId: number;
  readonly command: string;
  readonly workingDirectory: string;
  readonly toolCallId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly sandboxPolicy?: SandboxPolicy | undefined;
  readonly enableWriteShellStdinTool?: boolean | undefined;
  readonly description?: string | undefined;
  readonly outputNotification?: unknown;
}

export interface BackgroundAdoptState {
  readonly ctx: Context;
  readonly shellId: number;
  readonly command: string;
  readonly workingDirectory: string;
  readonly toolCallId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly sandboxPolicy?: SandboxPolicy | undefined;
  readonly initialOutput: string;
  readonly stdin?: NodeJS.WritableStream | undefined;
  readonly pid?: number | undefined;
  readonly abortController: AbortController;
  readonly eventIterator: AsyncIterator<ShellCoreEvent>;
  readonly startTime: number;
  readonly showElapsedTime: boolean;
  readonly description?: string | undefined;
  readonly outputNotification?: unknown;
}

export interface BackgroundShellFactory {
  spawn(executionContext: BackgroundSpawnContext, coreExecutor: unknown): Promise<BackgroundShell>;
  adopt(state: BackgroundAdoptState): Promise<BackgroundShell>;
}

export interface BackgroundWorkRegistry {
  enqueue(wakeup: Record<string, unknown>): void;
  upsertWork(record: Record<string, unknown>): void;
  clearWork(id: string): unknown;
  abortWork(id: string): boolean;
  hasRunningWork(filter?: unknown): boolean;
  abortAllWork(filter?: unknown): number;
  listWork(filter?: unknown): unknown[];
  pull(conversationId: string): unknown[];
  ack(ids: readonly string[]): unknown[];
  nack(ids: readonly string[], opts: unknown): void;
  suppress(conversationId: string, id: string): void;
  drainCompletions(): unknown[];
  hasPendingCompletions(conversationId?: string): boolean;
  markAwaitedCompletion(taskId: string): void;
}

export class CoreBackgroundShell implements BackgroundShell {
  readonly id: number;
  readonly abortController: AbortController;
  stdin: NodeJS.WritableStream | undefined;
  pid: number | undefined;
  private disposed = false;
  private completed = false;
  private completion: ShellCompletion | undefined;
  private completionListeners: Array<(completion: ShellCompletion) => void> = [];

  constructor(id: number, abortController: AbortController) {
    this.id = id;
    this.abortController = abortController;
  }

  abort(): void {
    this.abortController.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.abortController.signal.aborted) this.abortController.abort();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  onComplete(listener: (completion: ShellCompletion) => void): void {
    if (this.completed && this.completion) {
      listener(this.completion);
      return;
    }
    this.completionListeners.push(listener);
  }

  markCompleted(completion: ShellCompletion): void {
    if (this.completed) return;
    this.completed = true;
    this.completion = completion;
    const listeners = [...this.completionListeners];
    this.completionListeners = [];
    for (const listener of listeners) listener(completion);
  }
}

const MIN_SHELL_ID = 1_000;
const MAX_SHELL_ID = 999_999;

function randomInitialShellId(): number {
  return MIN_SHELL_ID + Math.floor(Math.random() * (MAX_SHELL_ID - MIN_SHELL_ID + 1));
}

interface ShellMetadata {
  readonly title?: string;
  readonly cwd?: string;
  readonly startTimeMs?: number;
}

export class BackgroundShellManager {
  private readonly runningShells = new Map<number, BackgroundShell>();
  private nextShellId = randomInitialShellId();

  constructor(
    private readonly factory: BackgroundShellFactory,
    private readonly backgroundWorkRegistry?: BackgroundWorkRegistry,
  ) {}

  private registerShellWork(shell: BackgroundShell, metadata: ShellMetadata): void {
    const shellId = String(shell.id);
    this.backgroundWorkRegistry?.upsertWork({
      id: shellId,
      kind: "shell",
      state: "running",
      metadata: encodeBackgroundWorkMetadata(metadata),
      abort: () => this.abort(shell.id),
    });
  }

  private clearShellWork(shellId: number): void {
    this.backgroundWorkRegistry?.clearWork(String(shellId));
  }

  private cleanupShell(shellId: number): void {
    if (!this.runningShells.has(shellId)) return;
    this.runningShells.delete(shellId);
    this.clearShellWork(shellId);
  }

  private enqueueShellCompletion(
    shellId: number,
    toolCallId: string | undefined,
    conversationId: string | undefined,
    commandTitle: string,
    completion: ShellCompletion,
  ): void {
    if (!this.backgroundWorkRegistry) return;
    const status = completion.aborted ? "aborted" : completion.code === 0 ? "success" : "error";
    const detail = !completion.aborted && completion.code !== null && completion.code !== 0
      ? `exit_code=${completion.code}`
      : undefined;
    const taskId = String(shellId);
    this.backgroundWorkRegistry.enqueue({
      conversationId: conversationId ?? LEGACY_LOCAL_WAKEUP_CONVERSATION_ID,
      id: taskId,
      source: "shell",
      payload: {
        taskId,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        kind: "shell",
        status,
        title: commandTitle,
        ...(detail ? { detail } : {}),
        ...(completion.outputPath ? { outputPath: completion.outputPath } : {}),
        reason: "task_finished",
      },
    });
  }

  async spawn(executionContext: BackgroundSpawnContext, coreExecutor: unknown): Promise<{ shellId: number; pid?: number | undefined }> {
    const shell = await this.factory.spawn(executionContext, coreExecutor);
    this.runningShells.set(shell.id, shell);
    this.registerShellWork(shell, {
      title: typeof executionContext.description === "string" && executionContext.description.length > 0
        ? executionContext.description
        : String(executionContext.command ?? ""),
      cwd: String(executionContext.workingDirectory ?? ""),
      startTimeMs: Date.now(),
    });
    shell.signal.addEventListener("abort", () => this.cleanupShell(shell.id));
    shell.onComplete?.((completion) => {
      this.enqueueShellCompletion(
        shell.id,
        typeof executionContext.toolCallId === "string" ? executionContext.toolCallId : undefined,
        typeof executionContext.conversationId === "string" ? executionContext.conversationId : undefined,
        typeof executionContext.description === "string" && executionContext.description.length > 0
          ? executionContext.description
          : String(executionContext.command ?? ""),
        completion,
      );
      this.cleanupShell(shell.id);
    });
    return { shellId: shell.id, pid: shell.pid };
  }

  async adopt(state: BackgroundAdoptState): Promise<{ shellId: number; pid?: number | undefined }> {
    const shell = await this.factory.adopt(state);
    this.runningShells.set(shell.id, shell);
    this.registerShellWork(shell, {
      title: typeof state.description === "string" && state.description.length > 0 ? state.description : String(state.command ?? ""),
      cwd: String(state.workingDirectory ?? ""),
      startTimeMs: typeof state.startTime === "number" ? state.startTime : Date.now(),
    });
    shell.signal.addEventListener("abort", () => this.cleanupShell(shell.id));
    shell.onComplete?.((completion) => {
      this.enqueueShellCompletion(
        shell.id,
        typeof state.toolCallId === "string" ? state.toolCallId : undefined,
        undefined,
        typeof state.description === "string" && state.description.length > 0 ? state.description : String(state.command ?? ""),
        completion,
      );
      this.cleanupShell(shell.id);
    });
    return { shellId: shell.id, pid: typeof state.pid === "number" ? state.pid : undefined };
  }

  generateShellId(): number {
    for (let attempts = 0; attempts <= MAX_SHELL_ID - MIN_SHELL_ID; attempts++) {
      if (this.nextShellId > MAX_SHELL_ID) this.nextShellId = MIN_SHELL_ID;
      const candidate = this.nextShellId;
      this.nextShellId += 1;
      if (!this.runningShells.has(candidate)) return candidate;
    }
    throw new Error("No available background shell id in range");
  }

  abort(shellId: number): boolean {
    const shell = this.runningShells.get(shellId);
    if (!shell) return false;
    shell.abort();
    this.runningShells.delete(shellId);
    this.clearShellWork(shellId);
    return true;
  }

  isRunning(shellId: number): boolean {
    return this.runningShells.has(shellId);
  }

  dispose(): void {
    for (const [shellId, shell] of this.runningShells) {
      shell.dispose();
      this.clearShellWork(shellId);
    }
    this.runningShells.clear();
  }

  async writeStdin(shellId: number, data: string): Promise<void> {
    const shell = this.runningShells.get(shellId);
    if (!shell) throw new Error("Shell not found");
    if (!shell.stdin) throw new Error("Shell stdin not available");
    const eotIndex = data.indexOf("\x04");
    const effectiveEofIndex = eotIndex !== -1 ? eotIndex : data.indexOf("\\u0004");
    if (effectiveEofIndex !== -1) {
      const beforeEof = data.substring(0, effectiveEofIndex);
      if (beforeEof.length > 0) {
        await new Promise<void>((resolve, reject) => {
          shell.stdin?.write(beforeEof, (error?: Error | null) => error ? reject(error) : resolve());
        });
      }
      shell.stdin.end();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      shell.stdin?.write(data, (error?: Error | null) => error ? reject(error) : resolve());
    });
  }
}

export class ConversationOwnerOverrideRegistry {
  constructor(
    private readonly inner: BackgroundWorkRegistry,
    private readonly ownerConversationId: string,
  ) {}

  enqueue(wakeup: Record<string, unknown>): void {
    this.inner.enqueue({ ...wakeup, conversationId: this.ownerConversationId });
  }

  enqueueCompletion(item: { readonly taskId: string; readonly kind: string; readonly [key: string]: unknown }): void {
    this.enqueue({ conversationId: this.ownerConversationId, id: item.taskId, source: item.kind, payload: item });
  }

  pull(conversationId: string): unknown[] {
    return this.inner.pull(conversationId);
  }

  ack(ids: readonly string[]): unknown[] {
    return this.inner.ack(ids);
  }

  nack(ids: readonly string[], opts: unknown): void {
    this.inner.nack(ids, opts);
  }

  suppress(conversationId: string, id: string): void {
    this.inner.suppress(conversationId, id);
  }

  upsertWork(record: Record<string, unknown>): void {
    this.inner.upsertWork(record);
  }

  clearWork(id: string): unknown {
    return this.inner.clearWork(id);
  }

  abortWork(id: string): boolean {
    return this.inner.abortWork(id);
  }

  hasRunningWork(filter?: unknown): boolean {
    return this.inner.hasRunningWork(filter);
  }

  abortAllWork(filter?: unknown): number {
    return this.inner.abortAllWork(filter);
  }

  listWork(filter?: unknown): unknown[] {
    return this.inner.listWork(filter);
  }

  drainCompletions(): unknown[] {
    return this.inner.drainCompletions();
  }

  hasPendingCompletions(conversationId?: string): boolean {
    return this.inner.hasPendingCompletions(conversationId);
  }

  markAwaitedCompletion(taskId: string): void {
    this.inner.suppress(this.ownerConversationId, taskId);
  }
}
