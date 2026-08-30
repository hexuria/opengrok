import { resolve } from "node:path";
import type { Context } from "../context/core.js";
import { BackgroundShellSpawnError, BackgroundShellSpawnResult, BackgroundShellSpawnSuccess } from "../proto/generated/agent/v1/background_shell_exec_pb.js";
import { ShellPermissionDenied, ShellRejected, ShellSandboxUnsupported } from "../proto/generated/agent/v1/shell_exec_pb.js";
import { ShellCommandParsingResult } from "../proto/generated/agent/v1/shell_exec_pb.js";
import type { SandboxPolicy as ProtoSandboxPolicy } from "../proto/generated/agent/v1/sandbox_pb.js";
import { getShellHookApprovalRequirement } from "../agent-exec/shell-hook-approval.js";
import { analyzeShellCommand } from "../shell-exec/shell-parser.js";
import { SandboxUnsupportedError } from "../shell-exec/sandbox/errors.js";
import { convertProtoToInternalPolicy } from "./sandbox-conversion.js";
import { isForcedShellEgressEnabled, forcedShellSandboxPolicy } from "./forced-egress.js";
import { getModelShellAdminCommandDenylistBlockReason } from "./services/admin-command-denylist.js";
import { shellBlockReasonMessage } from "./utils/edit-block-handler.js";
import type { ShellBlockReason } from "./utils/edit-block-handler.js";
import type { Context as ShellCoreContext } from "../context/core.js";
import type { SandboxPolicy, SandboxRule, ShellCoreArgs, ShellCoreEvent } from "./shell-core.js";
import {
  BackgroundShellManager,
  ConversationOwnerOverrideRegistry,
  CoreBackgroundShell,
  type BackgroundAdoptState,
  type BackgroundShell,
  type BackgroundShellFactory,
  type BackgroundSpawnContext,
  type BackgroundWorkRegistry,
} from "./background-shell-lifecycle.js";
import { FileLoggingShellFactory, NotifyingBackgroundShellFactory } from "./background-shell-observability.js";

export { BackgroundShellManager } from "./background-shell-lifecycle.js";
export type {
  BackgroundAdoptState,
  BackgroundShell,
  BackgroundShellFactory,
  BackgroundSpawnContext,
  BackgroundWorkRegistry,
} from "./background-shell-lifecycle.js";
export type BackgroundCompletion = import("./background-shell-lifecycle.js").ShellCompletion;

async function consumeShellEvents(shell: CoreBackgroundShell, eventIterator: AsyncIterator<ShellCoreEvent>): Promise<void> {
  let completion: import("./background-shell-lifecycle.js").ShellCompletion | undefined;
  try {
    for (let result = await eventIterator.next(); !result.done; result = await eventIterator.next()) {
      if (result.value.type === "stdin_ready") {
        shell.stdin = result.value.stdin;
        shell.pid = result.value.pid;
      } else if (result.value.type === "exit") {
        completion = {
          code: result.value.code,
          aborted: result.value.aborted,
          ...(result.value.outputLocation?.filePath === undefined ? {} : { outputPath: result.value.outputLocation.filePath }),
        };
      }
    }
  } catch {
    // Background completion is finalized below; the original execution error is
    // owned by the foreground stream and is intentionally not rethrown here.
  } finally {
    shell.markCompleted(completion ?? { code: null, aborted: shell.signal.aborted });
  }
}

interface BackgroundCoreExecutor {
  execute(ctx: ShellCoreContext, args: ShellCoreArgs): AsyncIterable<ShellCoreEvent>;
}

interface LocalBackgroundCoreExecutor extends BackgroundCoreExecutor {
  getCwd(): Promise<string>;
}

function isBackgroundCoreExecutor(value: unknown): value is BackgroundCoreExecutor {
  return typeof value === "object" && value !== null && "execute" in value && typeof value.execute === "function";
}

function runInBackground(fn: () => Promise<void>): void {
  fn().catch(() => {});
}

export class CoreShellFactory implements BackgroundShellFactory {
  async spawn(context: BackgroundSpawnContext, coreExecutor: unknown): Promise<BackgroundShell> {
    if (!isBackgroundCoreExecutor(coreExecutor)) throw new TypeError("Background shell core executor is not configured");
    const abortController = new AbortController();
    const shell = new CoreBackgroundShell(context.shellId, abortController);
    const eventIterator = coreExecutor.execute(context.ctx, {
      command: context.command,
      workingDirectory: context.workingDirectory,
      signal: abortController.signal,
      ...(context.toolCallId === undefined ? {} : { toolCallId: context.toolCallId }),
      ...(context.conversationId === undefined ? {} : { conversationId: context.conversationId }),
      ...(context.sandboxPolicy === undefined ? {} : { sandboxPolicy: context.sandboxPolicy }),
      ...(context.enableWriteShellStdinTool === undefined ? {} : { pipeStdin: context.enableWriteShellStdinTool }),
      showElapsedTime: true,
    })[Symbol.asyncIterator]();
    try {
      for (let result = await eventIterator.next(); !result.done; result = await eventIterator.next()) {
        if (result.value.type === "stdin_ready") {
          shell.stdin = result.value.stdin;
          shell.pid = result.value.pid;
          break;
        }
      }
    } catch (error) {
      if (error instanceof SandboxUnsupportedError) throw error;
    }
    runInBackground(() => consumeShellEvents(shell, eventIterator));
    return shell;
  }

  async adopt(state: BackgroundAdoptState): Promise<BackgroundShell> {
    const shell = new CoreBackgroundShell(state.shellId, state.abortController);
    shell.stdin = state.stdin;
    shell.pid = state.pid;
    runInBackground(() => consumeShellEvents(shell, state.eventIterator));
    return shell;
  }
}

type Decision = { kind: "block"; reason: ShellBlockReason } | { kind: "allow"; policy?: SandboxRule };
export interface BackgroundPermissions {
  shouldEnforceShellInvariantBlocks(ctx: Context, options: unknown, policy: SandboxRule | undefined): Promise<Decision>;
  shouldBlockShellCommand(ctx: Context, command: string, options: unknown, policy: SandboxRule | undefined): Promise<Decision>;
}
function createBackgroundShellFactory(projectDir: string): BackgroundShellFactory {
  const coreFactory = new CoreShellFactory();
  return new FileLoggingShellFactory(coreFactory, projectDir);
}

export class LocalBackgroundShellExecutor {
  private readonly manager: BackgroundShellManager;

  constructor(
    private readonly permissions: BackgroundPermissions,
    private readonly core: LocalBackgroundCoreExecutor,
    private readonly ignore: { getCursorIgnoreMapping(): Promise<unknown> },
    private readonly projectDir: string,
    factory?: BackgroundShellFactory,
    backgroundWorkRegistry?: BackgroundWorkRegistry,
    wakeupOwnerConversationId?: string,
  ) {
    const ownedRegistry = backgroundWorkRegistry !== undefined && wakeupOwnerConversationId !== undefined
      ? new ConversationOwnerOverrideRegistry(backgroundWorkRegistry, wakeupOwnerConversationId)
      : backgroundWorkRegistry;
    const baseShellFactory = factory ?? createBackgroundShellFactory(projectDir);
    const shellFactory = new NotifyingBackgroundShellFactory(baseShellFactory, projectDir, ownedRegistry);
    this.manager = new BackgroundShellManager(shellFactory, ownedRegistry);
  }

  getManager(): BackgroundShellManager { return this.manager; }
  dispose(): void { this.manager.dispose(); }

  async execute(ctx: Context, args: {
    command: string;
    workingDirectory?: string;
    toolCallId?: string;
    conversationId?: string;
    sandboxPolicy?: ProtoSandboxPolicy;
    adminCommandDenylist?: readonly string[];
    skipApproval?: boolean;
    smartModeApproval?: { reason?: string; requestId?: string };
    classifierResult?: unknown;
    enableWriteShellStdinTool?: boolean;
    description?: string;
    outputNotification?: unknown;
    hookApprovalRequirement?: import("../proto/generated/agent/v1/shell_exec_pb.js").ShellHookApprovalRequirement;
  }): Promise<BackgroundShellSpawnResult> {
    const command = args.command;
    const workingDirectory = resolve(args.workingDirectory || await this.core.getCwd());
    const analysis = analyzeShellCommand(command).structured;
    const parsed = new ShellCommandParsingResult({
      parsingFailed: analysis.parsingFailed,
      executableCommands: analysis.executableCommands.map((item) => ({
        name: item.name,
        fullText: item.fullText,
        args: item.args.map((arg) => ({ type: arg.type, value: arg.value })),
      })),
      hasRedirects: analysis.hasRedirects,
      hasCommandSubstitution: analysis.hasCommandSubstitution,
      ...(analysis.allRedirectsAreDevNull === undefined ? {} : { allRedirectsAreDevNull: analysis.allRedirectsAreDevNull }),
      redirects: analysis.redirects.map((item) => ({
        operator: item.operator,
        destinationFds: [...item.destinationFds],
        targetNodeType: item.targetNodeType,
        ...(item.targetText === undefined ? {} : { targetText: item.targetText }),
      })),
    });
    const model = getModelShellAdminCommandDenylistBlockReason({ command, parsingResult: parsed, blockedCommands: args.adminCommandDenylist ?? [] });
    if (model !== undefined) return new BackgroundShellSpawnResult({ result: { case: "rejected", value: new ShellRejected({ command, workingDirectory, reason: model }) } });
    let policy = args.sandboxPolicy ? convertProtoToInternalPolicy(args.sandboxPolicy) : undefined;
    const decision = args.skipApproval
      ? await this.permissions.shouldEnforceShellInvariantBlocks(ctx, { workingDirectory, skipUnsafeWorkingDirectoryBlock: true, command, parsingResult: parsed, toolCallId: args.toolCallId }, policy)
      : await this.permissions.shouldBlockShellCommand(ctx, command, { workingDirectory, timeout: 0, parsingResult: parsed, toolCallId: args.toolCallId, classifierResult: args.classifierResult, smartModeApprovalReason: args.smartModeApproval?.reason, smartModeApprovalRequestId: args.smartModeApproval?.requestId, hookApprovalRequirement: getShellHookApprovalRequirement(args) }, policy);
    if (decision.kind === "block") {
      if (decision.reason.type === "permissionsConfig") return new BackgroundShellSpawnResult({ result: { case: "permissionDenied", value: new ShellPermissionDenied({ command, workingDirectory, error: "Command blocked by permissions configuration", isReadonly: decision.reason.isReadonly ?? false }) } });
      return new BackgroundShellSpawnResult({ result: { case: "rejected", value: new ShellRejected({ command, workingDirectory, reason: shellBlockReasonMessage(decision.reason) }) } });
    }
    policy = decision.policy;
    if (isForcedShellEgressEnabled()) {
      policy = forcedShellSandboxPolicy(command, parsed);
      if (policy.type !== "insecure_none") policy = { ...policy, ignoreMapping: await this.ignore.getCursorIgnoreMapping() };
    }
    try {
      const shellId = this.manager.generateShellId();
      const spawn = await this.manager.spawn({
        ctx,
        shellId,
        command,
        workingDirectory,
        ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
        ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
        ...(policy === undefined ? {} : { sandboxPolicy: { perRepo: policy } }),
        ...(args.enableWriteShellStdinTool === undefined ? {} : { enableWriteShellStdinTool: args.enableWriteShellStdinTool }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.outputNotification === undefined ? {} : { outputNotification: args.outputNotification }),
      }, this.core);
      return new BackgroundShellSpawnResult({ result: { case: "success", value: new BackgroundShellSpawnSuccess({ shellId, command, workingDirectory, ...(spawn.pid === undefined ? {} : { pid: spawn.pid }) }) } });
    } catch (error) {
      if (error instanceof SandboxUnsupportedError) {
        const type = policy?.type ?? "unknown";
        return new BackgroundShellSpawnResult({ result: { case: "sandboxUnsupported", value: new ShellSandboxUnsupported({ command, workingDirectory, sandboxPolicyType: type, reason: error.reason ?? error.message, isReadonly: type === "workspace_readonly" }) } });
      }
      return new BackgroundShellSpawnResult({ result: { case: "error", value: new BackgroundShellSpawnError({ command, workingDirectory, error: error instanceof Error ? error.message : "Unknown error" }) } });
    }
  }

  writeStdin(id: number, data: string): Promise<void> { return this.manager.writeStdin(id, data); }
}
