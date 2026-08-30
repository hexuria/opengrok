import {
  computerUseAuditKind,
  createSandNavigationProbe,
} from "./sand-action-audit.js";
import { computerUseExecutorResource } from "../../packages/agent-exec/computer-use.js";
import { shellExecutorResource } from "../../packages/agent-exec/shell.js";
import { buildHostShellArgs } from "../box/box-shell-command.js";
import type { ComputerUseArgs } from "../../packages/proto/generated/agent/v1/computer_use_tool_pb.js";
import type { ShellArgs } from "../../packages/proto/generated/agent/v1/shell_exec_pb.js";
import { isNoMonitorComputerUseExecutor } from "../ports/box.js";
import { mergeTurnUsage, type TurnUsage } from "./turn-usage.js";

export interface ComputerUseRemoteConnection<Context> {
  readonly remoteAccessor: unknown;
}

export interface ComputerUseActionAuditor {
  record(record: unknown): void;
}

export interface ComputerUseCoordinationDependencies<Context> {
  readonly ctx: Context;
  readonly remoteBox: {
    ensureReady(context: Context, boxId: string): Promise<ComputerUseRemoteConnection<Context>>;
  };
  readonly initialNavigationProbe?: ReturnType<typeof createSandNavigationProbe<Context>>;
  getConversationId(): string;
  resolveBoxId(): string;
  actionAuditor(): ComputerUseActionAuditor | undefined;
  reportDiagnostic?(diagnostic: {
    readonly kind: "computer_use_prewarm_skipped";
    readonly stage: "box" | "browser";
    readonly errorClass: string;
  }): void;
  classifyError?(error: unknown): string;
}

interface GeneratedResourceAccessor<Context> {
  get(resource: typeof computerUseExecutorResource): {
    execute(context: Context, args: ComputerUseArgs): Promise<unknown>;
  };
  get(resource: typeof shellExecutorResource): {
    execute(context: Context, args: ShellArgs): Promise<unknown>;
  };
}

function isGeneratedResourceAccessor<Context>(value: unknown): value is GeneratedResourceAccessor<Context> {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "get") === "function";
}

export interface ComputerUseUsageSnapshot {
  readonly modelId?: string | undefined;
  readonly turnEndedCount: number;
  readonly usage?: TurnUsage | undefined;
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createComputerUseCoordination<Context>(
  dependencies: ComputerUseCoordinationDependencies<Context>,
) {
  const windowBySubagent = new Map<string, number>();
  const preparationBySubagent = new Map<
    string,
    Promise<ComputerUseRemoteConnection<Context> | undefined>
  >();
  const auditActionCounts = new Map<string, number>();
  const modelIds = new Set<string>();
  let turnEndedCount = 0;
  let usage: TurnUsage | undefined;
  let navigationProbe = dependencies.initialNavigationProbe;

  function reportPrewarmFailure(
    stage: "box" | "browser",
    error: unknown,
  ): void {
    dependencies.reportDiagnostic?.({
      kind: "computer_use_prewarm_skipped",
      stage,
      errorClass: dependencies.classifyError?.(error) ?? errorClass(error),
    });
  }

  return {
    allocateWindow(subagentAgentId: string): number | null {
      const existing = windowBySubagent.get(subagentAgentId);
      if (existing != null) return existing;
      const mainBusy = [...windowBySubagent.values()].includes(1);
      if (mainBusy) return null;
      windowBySubagent.set(subagentAgentId, 1);
      return 1;
    },

    freeWindow(subagentAgentId: string): void {
      windowBySubagent.delete(subagentAgentId);
      preparationBySubagent.delete(subagentAgentId);
    },

    prepareRemoteBox({
      agentId,
      boxId,
    }: {
      readonly agentId: string;
      readonly boxId: string;
    }): Promise<ComputerUseRemoteConnection<Context> | undefined> {
      const connection = dependencies.remoteBox.ensureReady(dependencies.ctx, boxId)
        .catch((error: unknown) => {
          reportPrewarmFailure("box", error);
          return undefined;
        });
      const preparation = connection.then(async (ready) => {
        if (ready == null) return undefined;
        if (!isGeneratedResourceAccessor<Context>(ready.remoteAccessor)) {
          throw new TypeError("computer-use remote accessor does not expose generated resources");
        }
        const computerUse = ready.remoteAccessor.get(computerUseExecutorResource);
        if (isNoMonitorComputerUseExecutor(computerUse)) return ready;
        await ready.remoteAccessor.get(shellExecutorResource).execute(
          dependencies.ctx,
          buildHostShellArgs({
            command: "box-chrome --sand-prepare",
            name: "box-chrome",
            workingDirectory: "/workspace",
            toolCallId: `sand-cua-browser-prepare-${agentId}`,
          }),
        );
        return ready;
      }).catch((error: unknown) => {
        reportPrewarmFailure("browser", error);
        return undefined;
      });
      preparationBySubagent.set(agentId, preparation);
      return connection;
    },

    preparationFor(subagentAgentId: string) {
      return preparationBySubagent.get(subagentAgentId);
    },

    recordAuditIntent(actionCase: string): void {
      if (dependencies.actionAuditor() == null) return;
      const kind = computerUseAuditKind(actionCase);
      if (kind == null) return;
      auditActionCounts.set(kind, (auditActionCounts.get(kind) ?? 0) + 1);
    },

    auditActionCounts(): ReadonlyMap<string, number> {
      return auditActionCounts;
    },

    recordTurnEnded(turnUsage: TurnUsage | undefined): void {
      turnEndedCount += 1;
      usage = mergeTurnUsage(usage, turnUsage);
    },

    recordModelId(modelId: string): void {
      modelIds.add(modelId);
    },

    usageSnapshot(): ComputerUseUsageSnapshot {
      const ids = [...modelIds];
      return {
        modelId: ids.length === 0 ? undefined : ids.length === 1 ? ids[0] : "mixed",
        turnEndedCount,
        usage,
      };
    },

    getOrCreateNavigationProbe(): ReturnType<typeof createSandNavigationProbe<Context>> | undefined {
      const auditor = dependencies.actionAuditor();
      if (auditor == null) return undefined;
      navigationProbe ??= createSandNavigationProbe({
        auditor,
        agentId: dependencies.getConversationId(),
        getBoxId: () => dependencies.resolveBoxId(),
        buildShellArgs: buildHostShellArgs,
      });
      return navigationProbe;
    },
  };
}
