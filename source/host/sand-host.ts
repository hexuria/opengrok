import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  commandErrorReportToTelemetry,
  commandSuccessReportToTelemetry
} from "./gateway-command-error.js";
import {
  createHostGatewayApi,
  type HostGatewayDependencies
} from "./host-gateway-api.js";
import {
  startHostPluginRegistry
} from "./extensions/registry.js";
import type { HostExtensionDeclaration } from "../internal/host-extensions.js";
import type { HostExtensionId } from "./extensions/extension-ids.generated.js";
import { createHostRequestContext } from "./host-request-context.js";
import {
  createHostRunnerComposition as createRecoveredHostRunnerComposition,
  type HostRunnerCompositionDependencies,
  type HostRunnerSession
} from "./host-runner-composition.js";
import { HostMcpAuthCompletion, type HostMcpAuthCompletionEvent } from "./mcp-auth/host-mcp-auth-completion.js";
import { SandAgentRunner, type SandAgentRunnerOptions } from "./runner/sand-agent-runner.js";
import { withBotBlockDetection } from "./runner/bot-block-detection.js";
import { withSiteVisitTracking, type ActionAuditor } from "./runner/site-visit-tracking.js";
import type { ErasedProductionBoxGeneratedPorts } from "./box/production.js";
import { SandHostEventBus } from "./host-event-bus.js";
import {
  loadInitialTranscriptResiliently,
  type InitialTranscriptLoader
} from "./host-initial-transcript-load.js";
import {
  createHostRosterBookkeeping,
  type AttachmentRosterPort,
  type BoxStoreSnapshotPort,
  type ForeverBoxRosterPort,
  type HostRosterBookkeeping,
  type HostRosterExtensions,
  type SnapshotBackstopPort,
  type SourceMapRosterPort,
  type TranscriptRosterPort
} from "./host-roster-bookkeeping.js";

export const BOX_READY_STAGE_MARKER_PATH = "/tmp/sand-box-ready-stage";
export const BOX_READY_REPORT_ATTEMPTS = 3;
export const BOX_READY_REPORT_RETRY_MS = 30_000;

type DynamicMethod = (...args: any[]) => any;
export type DynamicHostApi = Record<string, any>;

export interface HostExtensionRegistry {
  readonly order: readonly string[];
  api(id: "attachments"): AttachmentRosterPort & DynamicHostApi;
  api(id: "transcript"): TranscriptRosterPort & DynamicHostApi;
  api(id: "forever-box"): ForeverBoxRosterPort & DynamicHostApi;
  api(id: "state-backstop"): SnapshotBackstopPort & DynamicHostApi;
  api(id: "box-store-sync"): BoxStoreSnapshotPort & DynamicHostApi;
  api(id: "source-map"): SourceMapRosterPort & DynamicHostApi;
  api(id: string): DynamicHostApi;
  stop(): Promise<void>;
}

export interface HostLifecycleProgress {
  complete(report: Record<string, unknown>): void;
  fail(): void;
}

export interface HostRunnerComposition {
  createRunner(session: unknown, hooks: unknown): unknown;
  createGroupMemberRunner(
    session: unknown,
    hooks: unknown,
    overrides: Record<string, unknown>
  ): unknown;
  canAskLocalToolPermission(agentId: string): boolean;
  forgetLocalToolPermission(agentId: string): void;
  dispose(): Promise<void>;
}

export interface SandHostRuntime {
  startExtensions(host: {
    log(message: string): void;
    readonly events: SandHostEventBus<unknown>;
    isIdle(): boolean;
    whenBackgroundWorkReady: Promise<void>;
  }): Promise<HostExtensionRegistry>;
  createRunnerComposition(options: {
    extensions: HostExtensionRegistry;
    emitGatewayEvent(event: unknown): void;
  }): HostRunnerComposition;
  resolveMcpAuthCompletion(completion: unknown): void;
  registerConnectorConnectCard(event: unknown): void;
  createGatewayDependencies(options: {
    extensions: HostExtensionRegistry;
    hostEvents: SandHostEventBus<unknown>;
    rosterBookkeeping: HostRosterBookkeeping;
    getHealth(): SandHostHealth;
    decorateForeverBoxStatus(status: any): any;
    kickstartIfPending(agentId: string): Promise<boolean>;
    requestDiskSaverAudit(agentId: string): Promise<boolean>;
    releaseAgentBox(agentId: string): Promise<void>;
    forgetLocalToolPermission(agentId: string): void;
  }): HostGatewayDependencies;
  readonly isAgentLimitError?: (error: unknown) => boolean;
  readonly buildIdentityFallback?: string;
  readonly now?: () => number;
  readonly performanceNow?: () => number;
  readonly log?: Pick<Console, "log" | "error">;
  readonly readReadyMarker?: () => Promise<string | null>;
  readonly writeReadyMarker?: (bootId: string) => Promise<void>;
  readonly readyRetryDelay?: (milliseconds: number) => Promise<void>;
  /** Generated/external extension adapters which the shipped graph reads from its host. */
  readonly extensionHost?: Readonly<object>;
}

export interface ProductionSandHostPorts {
  /** The complete recovered extension declaration map, including generated-client bindings. */
  readonly extensionsById: Readonly<Record<HostExtensionId, HostExtensionDeclaration<unknown, any>>>;
  /** Generated Connect clients and other external adapters consumed by extension declarations. */
  readonly extensionHost: ProductionExtensionHostAdapters;
  /** The request context carried into box and runner calls. */
  readonly runnerContext: unknown;
  /**
   * The occurrence deriver/writer is generated outside the available transcript-mirror capsule.
   * It is required rather than silently disabling transcript persistence.
   */
  readonly createTranscriptMirror: NonNullable<HostRunnerCompositionDependencies<SandAgentRunner>["createTranscriptMirror"]>;
  readonly buildIdentityFallback?: string;
  readonly log?: Pick<Console, "log" | "error">;
}

/** Generated adapters read directly from the shipped extension host context. */
export interface ProductionExtensionHostAdapters {
  readonly boxGenerated: ErasedProductionBoxGeneratedPorts;
  readonly standaloneBoxExecDaemon?: boolean;
  convertCloudAgentConversationToTrace(conversation: unknown): readonly unknown[];
}

/**
 * Composes the clean-source production host around the recovered extension graph.
 * Only generated/external adapters remain caller supplied; host lifecycle, gateway,
 * MCP completion, request context, auditing, and runner construction are concrete.
 */
export function createProductionSandHost(ports: ProductionSandHostPorts): SandHost {
  let extensions: HostExtensionRegistry | undefined;
  const requireExtensions = (): HostExtensionRegistry => {
    if (extensions == null) throw new Error("production host extensions are not started");
    return extensions;
  };
  const mcpAuthCompletion = new HostMcpAuthCompletion({
    getMcp: () => requireExtensions().api("mcp") as ReturnType<HostMcpAuthCompletion["deps"]["getMcp"]>,
    getTranscript: () => requireExtensions().api("transcript") as unknown as ReturnType<HostMcpAuthCompletion["deps"]["getTranscript"]>
  });

  return new SandHost({
    extensionHost: ports.extensionHost,
    ...(ports.buildIdentityFallback === undefined ? {} : { buildIdentityFallback: ports.buildIdentityFallback }),
    ...(ports.log === undefined ? {} : { log: ports.log }),
    async startExtensions(host) {
      const started = await startHostPluginRegistry({
        host: { ...ports.extensionHost, ...host },
        extensionsById: ports.extensionsById
      });
      extensions = started as unknown as HostExtensionRegistry;
      return extensions;
    },
    createRunnerComposition({ extensions: started, emitGatewayEvent }) {
      return createRecoveredHostRunnerComposition<SandAgentRunner>({
        extensions: started,
        ctx: ports.runnerContext,
        emitGatewayEvent,
        buildRunner: options => new SandAgentRunner(options as SandAgentRunnerOptions),
        createRequestContext: options => createHostRequestContext(
          options.transcriptsDir,
          () => {
            const value = options.getUserTimeZone();
            return typeof value === "string" ? value : undefined;
          },
          async () => {
            const value = await options.resolveTeamRules();
            return Array.isArray(value) ? value : [];
          },
          () => {
            const value = options.getUserFullName();
            return typeof value === "string" ? value : undefined;
          }
        ),
        createTranscriptMirror: ports.createTranscriptMirror,
        decorateActionAuditor(auditor, callbacks) {
          const base = auditor as ActionAuditor;
          return withSiteVisitTracking(
            withBotBlockDetection(base, callbacks.onBotBlock),
            callbacks.onSiteVisit
          );
        }
      });
    },
    resolveMcpAuthCompletion(completion) {
      mcpAuthCompletion.resolve(completion as HostMcpAuthCompletionEvent);
    },
    registerConnectorConnectCard(event) {
      mcpAuthCompletion.registerConnectCard(event as Parameters<HostMcpAuthCompletion["registerConnectCard"]>[0]);
    },
    createGatewayDependencies(options) {
      return {
        ...options,
        handleDesktopMcpAuthCompletion: completion =>
          mcpAuthCompletion.resolveDesktop(completion as HostMcpAuthCompletionEvent)
      };
    }
  });
}

export interface SandHostHealth {
  readonly isBusy: boolean;
  readonly busyOnlyAwaitingApproval: boolean;
  readonly activeAgentId: string | null;
  readonly lastBusyAtMs: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

function optionalMethod(api: DynamicHostApi, name: string): DynamicMethod | undefined {
  const candidate = api[name];
  return typeof candidate === "function" ? candidate.bind(api) : undefined;
}

/**
 * Owns the host extension graph and the gateway-visible runtime state.
 */
export class SandHost {
  readonly startedAt: number;
  readonly hostEvents: SandHostEventBus<unknown>;
  readonly listeners = new Set<(event: unknown) => void>();

  private readonly backgroundWorkReady = deferred<void>();
  private hostExtensions: HostExtensionRegistry | undefined;
  private rosterBookkeeping: HostRosterBookkeeping | undefined;
  private runnerComposition: HostRunnerComposition | undefined;
  private lastBusyAtMs: number;

  constructor(readonly runtime: SandHostRuntime) {
    const now = runtime.now ?? Date.now;
    this.startedAt = now();
    this.lastBusyAtMs = this.startedAt;
    this.hostEvents = new SandHostEventBus(report => {
      const logs = this.telemetryLogsOrUndefined();
      optionalMethod(logs ?? {}, "reportHostEventBusFailure")?.(report);
    });
  }

  private get log(): Pick<Console, "log" | "error"> {
    return this.runtime.log ?? console;
  }

  private telemetryApiOrUndefined(): DynamicHostApi | undefined {
    return this.hostExtensions?.api("telemetry");
  }

  private telemetryLogsOrUndefined(): DynamicHostApi | undefined {
    return this.telemetryApiOrUndefined()?.logs as DynamicHostApi | undefined;
  }

  reportProcessCrash(error: unknown, kind: string): void {
    try {
      optionalMethod(
        this.telemetryLogsOrUndefined() ?? {},
          "reportHostCrash"
      )?.(kind);
    } catch {
      // Crash reporting is best-effort and must not recursively crash the host.
    }
  }

  reportHostDiagnostic(diagnostic: unknown): void {
    optionalMethod(
      this.telemetryLogsOrUndefined() ?? {},
      "reportHostDiagnostic"
    )?.(diagnostic);
  }

  reportInvariantViolation(report: unknown): void {
    optionalMethod(
      this.telemetryLogsOrUndefined() ?? {},
      "reportInvariantViolation"
    )?.(report);
  }

  reportGatewayCommandError(report: Record<string, unknown> & {
    method: string;
    reason: string;
    errorClass: string;
    durationMs: number;
  }): void {
    try {
      const { level, metadata } = commandErrorReportToTelemetry(report);
      optionalMethod(
        this.telemetryLogsOrUndefined() ?? {},
        "reportGatewayCommandError"
      )?.(level, metadata);
    } catch {}
  }

  reportGatewayCommandSuccess(report: Record<string, unknown> & {
    method: string;
    durationMs: number;
  }): void {
    try {
      const { level, metadata } = commandSuccessReportToTelemetry(report);
      optionalMethod(
        this.telemetryApiOrUndefined() ?? {},
        "reportGatewayCommandTiming"
      )?.(level, metadata);
    } catch {}
  }

  async start(): Promise<void> {
    const lifecycleStartedAt = this.runtime.performanceNow?.() ?? performance.now();
    const hostExtensions = await this.runtime.startExtensions({
      ...(this.runtime.extensionHost ?? {}),
      log: message => this.log.log(`[sand-host] ${message}`),
      events: this.hostEvents,
      isIdle: () => {
        const runningTurns = this.rosterBookkeeping?.isBusy === true;
        const backgroundShell = this.hostExtensions == null
          ? false
          : Boolean(
              optionalMethod(
                this.hostExtensions.api("transcript"),
                "hasRunningBackgroundShellWork"
              )?.()
            );
        return !runningTurns && !backgroundShell;
      },
      whenBackgroundWorkReady: this.backgroundWorkReady.promise
    });
    this.hostExtensions = hostExtensions;

    const telemetry = hostExtensions.api("telemetry");
    const createLifecycle = optionalMethod(
      telemetry,
      "createHostLifecycleProgress"
    );
    if (createLifecycle == null) {
      throw new Error("telemetry extension does not expose host lifecycle progress");
    }
    const lifecycle: HostLifecycleProgress = createLifecycle(lifecycleStartedAt);

    try {
      await this.startWithLifecycle(lifecycle);
    } catch (error) {
      lifecycle.fail();
      throw error;
    }
  }

  private async startWithLifecycle(
    lifecycle: HostLifecycleProgress
  ): Promise<void> {
    const extensions = this.requireHostExtensions();
    lifecycle.complete({
      phase: "plugin_graph",
      pluginCount: extensions.order.length
    });
    this.log.log(
      `[sand-host] host extensions started in graph order: ${extensions.order.join(" -> ")}`
    );

    this.wireExtensionGatewayEvents(extensions);
    const foreverBox = extensions.api("forever-box");
    this.wireDiskPressureGateway(foreverBox);
    this.wireBoxHandoffEvents();

    this.rosterBookkeeping = createHostRosterBookkeeping(extensions);
    this.runnerComposition = this.runtime.createRunnerComposition({
      extensions,
      emitGatewayEvent: event => this.emit(event)
    });
    this.bindExecutionPorts();

    const hostUpgrade = extensions.api("host-upgrade");
    const resolveIdentity = optionalMethod(
      hostUpgrade,
      "resolveHostBundleIdentityVersion"
    );
    const hostBundleVersion = resolveIdentity == null
      ? this.runtime.buildIdentityFallback ?? "unknown"
      : await resolveIdentity(this.runtime.buildIdentityFallback ?? "unknown");

    let boxStoreId: unknown;
    try {
      boxStoreId = await optionalMethod(
        extensions.api("box-store-sync"),
        "getStoreId"
      )?.();
    } catch {
      boxStoreId = undefined;
    }

    lifecycle.complete({ phase: "identity" });
    await optionalMethod(extensions.api("telemetry"), "setHostBundleIdentity")?.({
      hostBundleVersion,
      ...(boxStoreId === undefined ? {} : { boxStoreId })
    });

    lifecycle.complete({ phase: "log_catchup" });
    const entryCount = await this.ensureLoadedResiliently();
    lifecycle.complete({ phase: "transcript_read", entryCount });

    this.finishBackgroundStartup(hostBundleVersion);
    lifecycle.complete({ phase: "ready" });
  }

  private wireExtensionGatewayEvents(extensions: HostExtensionRegistry): void {
    const mcp = extensions.api("mcp");
    optionalMethod(mcp, "subscribeToAuthCompletion")?.(
      (completion: unknown) => this.runtime.resolveMcpAuthCompletion(completion)
    );
    optionalMethod(mcp, "subscribeToServersUpdated")?.((payload: unknown) => {
      this.emit({ channel: "mcp-servers", payload });
    });
    optionalMethod(extensions.api("cross-user-sharing"), "subscribe")?.(
      (payload: unknown) => this.emit({ channel: "sharing", payload })
    );
    optionalMethod(extensions.api("settings"), "subscribeToChanges")?.(
      (payload: unknown) => this.emit({ channel: "host-settings", payload })
    );
  }

  private wireBoxHandoffEvents(): void {
    this.hostEvents.on("session.box-handoff-started", payload => {
      const event = payload as { agentId: string; instruction: string };
      const sink = optionalMethod(this.transcript, "createAwaitingStateSink")?.();
      sink?.set(event.agentId, {
        tabId: "box",
        reason: event.instruction,
        since: (this.runtime.now ?? Date.now)()
      });
    });

    this.hostEvents.on("session.box-handoff-ended", async payload => {
      const event = payload as {
        agentId: string;
        requestId: string;
        resolution: unknown;
        trigger: unknown;
      };
      const pendingApproval = optionalMethod(
        this.requireHostExtensions().api("auto-review"),
        "pendingAwaitingState"
      )?.(event.agentId);
      const sink = optionalMethod(this.transcript, "createAwaitingStateSink")?.();
      if (pendingApproval == null) sink?.clear(event.agentId);
      else sink?.set(event.agentId, pendingApproval);
      await optionalMethod(this.transcript, "resolveBoxRequestEntry")?.(
        event.agentId,
        event.requestId,
        event.resolution
      );
      await this.emitForeverBox(event.agentId);
      await optionalMethod(this.transcript, "resumeAfterBoxHandoff")?.(
        event.agentId,
        event.trigger
      );
    });

    this.hostEvents.on("session.box-handoff-status-changed", payload => {
      const event = payload as { agentId: string };
      void this.emitForeverBox(event.agentId);
    });
  }

  private bindExecutionPorts(): void {
    const extensions = this.requireHostExtensions();
    const composition = this.requireRunnerComposition();
    const localToolPermission = extensions.api("local-tool-permission");
    optionalMethod(localToolPermission, "bindAskSurfaces")?.(
      (agentId: string) => composition.canAskLocalToolPermission(agentId)
    );
    optionalMethod(localToolPermission, "bindLiveComputerCheck")?.(
      (agentId: string) =>
        optionalMethod(
          extensions.api("local-exec"),
          "checkLiveComputerForAsk"
        )?.(agentId) ?? false
    );

    optionalMethod(extensions.api("turn-execution"), "bindExecutor")?.({
      createRunner: (session: unknown, hooks: unknown) =>
        composition.createRunner(session, hooks),
      createGroupMemberRunner: (
        session: unknown,
        hooks: unknown,
        overrides: Record<string, unknown>
      ) => composition.createGroupMemberRunner(session, hooks, overrides),
      isInferenceReady: () =>
        optionalMethod(extensions.api("inference"), "isReady")?.() ?? false
    });
  }

  private async ensureLoadedResiliently(): Promise<number> {
    const transcript = this.transcript as InitialTranscriptLoader<unknown>;
    const entryCount = await loadInitialTranscriptResiliently(transcript, {
      ...(this.runtime.isAgentLimitError === undefined
        ? {}
        : { isAgentLimitError: this.runtime.isAgentLimitError }),
      logError: (message, error) => {
        if (error === undefined) this.log.error(message);
        else this.log.error(message, error);
      }
    });
    this.requireRosterBookkeeping().apply(
      optionalMethod(this.transcript, "getActiveAgentId")?.()
    );
    return entryCount;
  }

  private finishBackgroundStartup(hostBundleVersion: string): void {
    const extensions = this.requireHostExtensions();
    const transcript = this.transcript;
    const activeAgentId = optionalMethod(transcript, "getActiveAgentId")?.();
    if (typeof activeAgentId === "string") {
      void this.kickstartIfPending(activeAgentId);
    }

    optionalMethod(transcript, "setAgentForgottenObserver")?.(
      (agentId: string) => {
        void optionalMethod(extensions.api("box-store-sync"), "forgetAgent")?.(
          agentId
        );
        const reminder = extensions.api("forever-box").diskPressureReminder as
          | DynamicHostApi
          | undefined;
        optionalMethod(reminder ?? {}, "forgetAgent")?.(agentId);
      }
    );
    optionalMethod(transcript, "setShouldEmitAutomations")?.(
      () => this.listeners.size > 0
    );

    this.wireEvents();
    this.backgroundWorkReady.resolve(undefined);

    optionalMethod(extensions.api("host-upgrade"), "startSharedUpdateWatch")?.({
      isBoxAutoUpdateEnabled: false,
      runRootUpdateTick: async () => {}
    });
    void optionalMethod(extensions.api("automations"), "reconcileNow")?.();
    optionalMethod(transcript, "setConnectorConnectCardObserver")?.(
      (event: unknown) => this.runtime.registerConnectorConnectCard(event)
    );
    void optionalMethod(
      extensions.api("host-upgrade"),
      "resumeInterruptedUpgradeTurns"
    )?.();
    void optionalMethod(transcript, "rearmPendingWakes")?.();
    void optionalMethod(transcript, "redriveUnfulfilledAckObligations")?.();

    optionalMethod(this.telemetryLogsOrUndefined() ?? {}, "reportHostStartup")?.({
      auto_update: String(
        extensions.api("forever-box").isAutoUpdateEnabled ?? false
      ),
      duration_ms: String((this.runtime.now ?? Date.now)() - this.startedAt),
      host_bundle_version: hostBundleVersion
    });
    optionalMethod(extensions.api("host-upgrade"), "activateAfterHostIdentityReady")?.();
  }

  async kickstartIfPending(agentId: string): Promise<boolean> {
    const inferenceReady = await optionalMethod(
      this.requireHostExtensions().api("inference"),
      "isReady"
    )?.() ?? false;
    return await optionalMethod(this.transcript, "kickstartAgent")?.(
      agentId,
      inferenceReady
    ) ?? false;
  }

  async requestDiskSaverAudit(agentId: string): Promise<boolean> {
    const inferenceReady = await optionalMethod(
      this.requireHostExtensions().api("inference"),
      "isReady"
    )?.() ?? false;
    return await optionalMethod(this.transcript, "requestDiskSaverAudit")?.(
      agentId,
      inferenceReady
    ) ?? false;
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    const level = this.requireHostExtensions()
      .api("forever-box").diskPressureLevel;
    listener({
      channel: "box-disk-pressure",
      payload: level == null ? null : { level }
    });
    return () => {
      this.listeners.delete(listener);
    };
  }

  private wireDiskPressureGateway(foreverBox: DynamicHostApi): void {
    optionalMethod(foreverBox, "subscribeToDiskPressure")?.(
      (level: unknown) => {
        if (level != null) {
          foreverBox.diskPressureReminder?.enroll?.(
            optionalMethod(this.transcript, "liveRunningAgentIds")?.() ?? []
          );
        }
        this.emit({
          channel: "box-disk-pressure",
          payload: level == null ? null : { level }
        });
        const activeAgentId =
          optionalMethod(this.transcript, "getActiveAgentId")?.() ??
          this.rosterBookkeeping?.latestActiveAgentId;
        if (typeof activeAgentId === "string") {
          void this.emitForeverBox(activeAgentId);
        }
      }
    );
  }

  noteEventStreamClosed(): void {
    void optionalMethod(this.transcript, "setWindowFocused")?.(false);
  }

  noteDesktopContact(): void {
    optionalMethod(this.transcript, "noteDesktopContact")?.();
  }

  getApi(): Record<string, DynamicMethod> {
    const extensions = this.requireHostExtensions();
    const rosterBookkeeping = this.requireRosterBookkeeping();
    return createHostGatewayApi(this.runtime.createGatewayDependencies({
      extensions,
      hostEvents: this.hostEvents,
      rosterBookkeeping,
      getHealth: () => this.getHealth(),
      decorateForeverBoxStatus: status => this.decorateForeverBoxStatus(status),
      kickstartIfPending: agentId => this.kickstartIfPending(agentId),
      requestDiskSaverAudit: agentId => this.requestDiskSaverAudit(agentId),
      releaseAgentBox: agentId => this.releaseAgentBox(agentId),
      forgetLocalToolPermission: agentId => this.forgetLocalToolPermission(agentId)
    }));
  }

  forgetLocalToolPermission(agentId: string): void {
    this.runnerComposition?.forgetLocalToolPermission(agentId);
  }

  getHealth(): SandHostHealth {
    const transcript = this.transcript;
    const runningTurnsBusy = this.rosterBookkeeping?.isBusy === true;
    const otherWorkBusy = Boolean(
      optionalMethod(transcript, "hasRunningBackgroundShellWork")?.() ||
      optionalMethod(transcript, "hasCarryablePendingWake")?.() ||
      optionalMethod(transcript, "hasMidDrainRevival")?.()
    );
    const isBusy = runningTurnsBusy || otherWorkBusy;
    const busyOnlyAwaitingApproval =
      runningTurnsBusy && !otherWorkBusy && this.allRunningAgentsAwaitApproval();

    if (isBusy && !busyOnlyAwaitingApproval) {
      this.lastBusyAtMs = (this.runtime.now ?? Date.now)();
    }

    return {
      isBusy,
      busyOnlyAwaitingApproval,
      activeAgentId: this.rosterBookkeeping?.latestActiveAgentId ?? null,
      lastBusyAtMs: this.lastBusyAtMs
    };
  }

  private allRunningAgentsAwaitApproval(): boolean {
    const extensions = this.hostExtensions;
    if (extensions == null) return false;
    if (optionalMethod(this.transcript, "hasAgentsWithRunningSubagents")?.()) {
      return false;
    }

    const running = new Set<string>(
      optionalMethod(this.transcript, "liveRunningAgentIds")?.() ?? []
    );
    if (running.size === 0) return false;
    const awaiting = new Set<string>(
      optionalMethod(
        extensions.api("auto-review"),
        "agentIdsWithPendingApprovals"
      )?.() ?? []
    );
    for (const agentId of running) {
      if (!awaiting.has(agentId)) return false;
    }
    return true;
  }

  async prepareForUpgrade(): Promise<unknown> {
    return await optionalMethod(
      this.requireHostExtensions().api("host-upgrade"),
      "prepareForUpgrade"
    )?.() ?? {};
  }

  getLocalExecBridge(): unknown {
    return this.requireHostExtensions().api("local-exec");
  }

  getWebAuthnBridge(): unknown {
    return this.requireHostExtensions().api("webauthn-proxy");
  }

  async dispose(): Promise<void> {
    const extensions = this.hostExtensions;
    if (extensions == null) return;

    if (optionalMethod(this.transcript, "isQuiescingForUpgrade")?.()) {
      optionalMethod(
        this.transcript,
        "markAllRunningAgentsForUpgradeResume"
      )?.();
    }
    optionalMethod(extensions.api("managed-setup"), "dispose")?.();
    await optionalMethod(extensions.api("automations"), "suspendWakes")?.();
    optionalMethod(extensions.api("cross-user-sharing"), "prepareForUpgrade")?.();
    optionalMethod(extensions.api("auto-review"), "expirePendingApprovals")?.();
    await optionalMethod(this.transcript, "dispose")?.();
    await this.runnerComposition?.dispose();
    this.runnerComposition = undefined;
    await extensions.stop();
  }

  async flushTelemetryForFatalExit(): Promise<void> {
    try {
      await optionalMethod(
        this.telemetryApiOrUndefined() ?? {},
        "flushForFatalExit"
      )?.();
    } catch {}
  }

  async reportBoxReady(): Promise<void> {
    const bootId = process.env.SAND_BOX_BOOT_ID?.trim();
    const bootStartedAtMs = Number(process.env.SAND_BOX_BOOT_STARTED_AT_MS);
    if (!bootId || !Number.isFinite(bootStartedAtMs)) return;

    const readMarker = this.runtime.readReadyMarker ?? (async () =>
      readFile(BOX_READY_STAGE_MARKER_PATH, "utf8").catch(() => null));
    if (await readMarker() === bootId) return;

    const readyDurationMs = Math.max(
      0,
      (this.runtime.now ?? Date.now)() - bootStartedAtMs
    );
    const logs = this.telemetryLogsOrUndefined();
    const reportConfirmed = logs == null
      ? undefined
      : optionalMethod(logs, "reportBoxBootStageConfirmed");
    if (reportConfirmed == null) return;

    const writeMarker = this.runtime.writeReadyMarker ?? (async id => {
      await writeFile(BOX_READY_STAGE_MARKER_PATH, id);
    });
    const wait = this.runtime.readyRetryDelay ?? (async milliseconds => {
      await delay(milliseconds);
    });

    for (let attempt = 1; attempt <= BOX_READY_REPORT_ATTEMPTS; attempt += 1) {
      const delivered = await reportConfirmed({
        stage: "ready",
        durationMs: readyDurationMs
      });
      if (delivered) {
        try {
          await writeMarker(bootId);
        } catch {
          // The telemetry report already succeeded; a marker failure only
          // permits a duplicate report on the next process start.
        }
        return;
      }
      if (attempt < BOX_READY_REPORT_ATTEMPTS) {
        await wait(BOX_READY_REPORT_RETRY_MS);
      }
    }
  }

  private requireHostExtensions(): HostExtensionRegistry {
    if (this.hostExtensions == null) {
      throw new Error(
        "[sand-host] host extensions are not started; SandHost.start() walks the peer graph before any capability is used"
      );
    }
    return this.hostExtensions;
  }

  private requireRosterBookkeeping(): HostRosterBookkeeping {
    if (this.rosterBookkeeping == null) {
      throw new Error(
        "[sand-host] roster bookkeeping is not built; startup builds it before the agents stream is wired"
      );
    }
    return this.rosterBookkeeping;
  }

  private requireRunnerComposition(): HostRunnerComposition {
    if (this.runnerComposition == null) {
      throw new Error(
        "[sand-host] runner composition is not built; startup binds it before any turn can run"
      );
    }
    return this.runnerComposition;
  }

  private get transcript(): DynamicHostApi {
    return this.requireHostExtensions().api("transcript");
  }

  private async emitForeverBox(agentId: string): Promise<void> {
    try {
      const status = await optionalMethod(
        this.requireHostExtensions().api("forever-box"),
        "getStatus"
      )?.({ id: agentId });
      this.emit({
        channel: "forever-box",
        payload: this.decorateForeverBoxStatus(status)
      });
    } catch {
      // Status pushes are best-effort and retried by later lifecycle events.
    }
  }

  private decorateForeverBoxStatus(status: any): any {
    const extensions = this.requireHostExtensions();
    const versionState = optionalMethod(
      extensions.api("host-upgrade"),
      "getVersionState"
    )?.() ?? {};
    const handoff = optionalMethod(
      extensions.api("session"),
      "pendingHandoff"
    )?.(status?.agentId);
    const diskPressureLevel = extensions.api("forever-box").diskPressureLevel;

    return {
      ...status,
      handoff,
      ...(versionState.hostVersion == null
        ? {}
        : { hostVersion: versionState.hostVersion }),
      ...(versionState.hostUpdateAvailable == null
        ? {}
        : { hostUpdateAvailable: versionState.hostUpdateAvailable }),
      ...(diskPressureLevel == null
        ? {}
        : { diskPressure: { level: diskPressureLevel } })
    };
  }

  private async releaseAgentBox(agentId: string): Promise<void> {
    await optionalMethod(
      this.requireHostExtensions().api("forever-box"),
      "releaseAgent"
    )?.(agentId);
  }

  private wireEvents(): void {
    const extensions = this.requireHostExtensions();
    const transcript = this.transcript;

    this.hostEvents.emit({
      kind: "notification-baseline",
      agents: optionalMethod(transcript, "listAgentsSync")?.() ?? []
    });
    optionalMethod(transcript, "subscribe")?.(
      (payload: unknown) => this.emit({ channel: "transcript", payload })
    );
    optionalMethod(transcript, "subscribeClientSideToolV2")?.(
      (payload: unknown) => this.emit({ channel: "client-side-tool-v2", payload })
    );
    optionalMethod(transcript, "subscribeAgents")?.((payload: any) => {
      this.requireRosterBookkeeping().apply(payload.activeAgentId);
      this.hostEvents.emit({
        kind: "notification-agents",
        event: payload,
        presence: {
          windowFocusedAtMs: optionalMethod(
            transcript,
            "getWindowFocusedAtMs"
          )?.()
        }
      });
      this.emit({ channel: "agents", payload });
    });
    optionalMethod(transcript, "subscribeAgentUpserted")?.((payload: any) => {
      this.requireRosterBookkeeping().apply(payload.activeAgentId);
      this.hostEvents.emit({
        kind: "notification-agent-upserted",
        event: payload,
        presence: {
          windowFocusedAtMs: optionalMethod(
            transcript,
            "getWindowFocusedAtMs"
          )?.()
        }
      });
      this.emit({ channel: "agent-upserted", payload });
    });

    const channels: Array<[string, string]> = [
      ["subscribeOutline", "outline"],
      ["subscribeSubagents", "subagents"],
      ["subscribeAsyncTasks", "async-tasks"],
      ["subscribeAutomations", "automations"],
      ["subscribeWorkflows", "workflows"]
    ];
    for (const [method, channel] of channels) {
      optionalMethod(transcript, method)?.((payload: unknown) => {
        this.emit({ channel, payload });
      });
    }

    optionalMethod(extensions.api("memory"), "subscribe")?.(
      (payload: unknown) => this.emit({ channel: "memory", payload })
    );
    optionalMethod(extensions.api("trays"), "subscribe")?.(
      (payload: unknown) => this.emit({ channel: "tray", payload })
    );
    optionalMethod(extensions.api("forever-box"), "subscribe")?.(
      (payload: unknown) => this.emit({
        channel: "forever-box",
        payload: this.decorateForeverBoxStatus(payload)
      })
    );
    optionalMethod(extensions.api("teach-recording"), "subscribe")?.(
      (payload: unknown) => this.emit({ channel: "teach-recording", payload })
    );
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}
