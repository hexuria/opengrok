import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createExpiryPolicy,
  realClock,
  type Clock,
  type ExpiryPolicy,
} from "../../../internal/scheduling.js";
import {
  getAgentAssetsDir,
  getAgentAttachmentsDir,
} from "../../attachment-paths.js";
import { createNoopSandProductAnalytics } from "../../ports/product-analytics.js";
import { createNoopSandTelemetry } from "../../ports/telemetry.js";
import {
  AckObligations,
  ACK_REDRIVE_IDLE_DELAY_MS,
} from "./ack-obligations.js";
import { AgentLifecycle } from "./agent-lifecycle.js";
import { AutomationRuntime } from "./automation-runtime.js";
import { BackgroundWakes } from "./background-wakes.js";
import { BoxHandoffResume } from "./box-handoff-resume.js";
import { SandChannelDeliveryUnregisteredError } from "./channel-delivery-unregistered-error.js";
import { TranscriptEntryDeletion } from "./entry-deletion.js";
import { GroupChatGlue } from "./group-chat-glue.js";
import { PendingWakeRearm } from "./pending-wake-rearm.js";
import { PromptAcceptanceLedger } from "./prompt-acceptance-ledger.js";
import { RosterProjection } from "./roster-projection.js";
import { RunLifecycle } from "./run-lifecycle.js";
import { RunnerRegistry } from "./runner-registry.js";
import { SendPipeline } from "./send-pipeline.js";
import {
  SessionRuntime,
  type LiveTranscriptSession,
} from "./session-runtime.js";
import { SharedRooms } from "./shared-rooms.js";
import { RUNNER_UNATTACHED_MESSAGE } from "./transcript-hub.js";
import { TurnRuntime } from "./turn-runtime.js";
import { UpgradeRecreateResume } from "./upgrade-recreate-resume.js";
import { WidgetResponses } from "./widget-responses.js";
import { WorkflowCommands } from "./workflow-commands.js";
import { ClientSideToolV2Producer } from "./client-side-tool-v2-producer.js";

export interface TaskBoundary {
  settled(): Promise<void>;
}
export function createTranscriptTaskBoundary(): TaskBoundary {
  return { settled: () => Promise.resolve() };
}

export interface TurnExecutionPort {
  readonly canExecute: boolean;
  readonly canExecuteGroupMember: boolean;
  isRunReady(): Promise<boolean>;
  createRunner(...args: any[]): any;
  createGroupMemberRunner(...args: any[]): any;
}

export const UNWIRED_TURN_EXECUTION: TurnExecutionPort = {
  canExecute: false,
  canExecuteGroupMember: false,
  isRunReady: async () => true,
  createRunner: () => {
    throw new Error(RUNNER_UNATTACHED_MESSAGE);
  },
  createGroupMemberRunner: () => {
    throw new Error(RUNNER_UNATTACHED_MESSAGE);
  },
};

export const NOOP_TRANSCRIPT_ATTACHMENTS = {
  ingest: async (_agentDir: string, sourcePath: string) => ({
    absolutePath: sourcePath,
  }),
  ingestBytes: async (
    agentDir: string,
    filename: string,
    _data?: Uint8Array,
  ) => ({ absolutePath: join(getAgentAttachmentsDir(agentDir), filename) }),
  persistImageBytes: async (targetDir: string, data: Uint8Array) => {
    const absolutePath = join(targetDir, "unwired-image");
    return {
      absolutePath,
      fileUrl: pathToFileURL(absolutePath).href,
      bytes: data.byteLength,
      width: null,
      height: null,
    };
  },
  readImageDimensions: async (_path: string) => null,
};

export const EMPTY_FOREVER_BOX = {
  getStatus: async ({ id }: { id: string }) => ({
    agentId: id,
    state: "absent",
    vncUrl: null,
  }),
  captureScreenshot: async () => null,
};

export const NO_TRAY_ERRORS = {
  pushError: (_error: unknown) => {},
  clearForAgent: (_id: string) => {},
};

export function unavailableMemoryStore() {
  return {
    recall: () => ({ profile: [], recent: [] }),
    listMemories: () => [],
    addMemory: () => null,
    removeMemoryByContent: () => false,
    getLocation: () => null,
    setOnChange: () => {},
    removeMemory: () => false,
    clearMemories: () => {},
  };
}

export const NO_MEMORY = {
  createAgentStore: () => unavailableMemoryStore(),
  agentHasContent: () => false,
  list: async () => [],
  remove: async () => [],
  clear: async () => [],
  setActiveAgent: (_id: string | null) => {},
};

export const NO_CONTENT_SEARCH = {
  isSearchReady: false,
  maxMatchesPerAgent: 5,
  maxResults: 50,
  searchMessages: () => null,
  searchMedia: () => null,
  findTranscriptMatches: () => [],
};

function invoke(target: unknown, method: string, args: any[]): any {
  const callable = (target as Record<string, unknown>)[method];
  if (typeof callable !== "function") return undefined;
  return callable.apply(target, args);
}

export class TranscriptManager {
  readonly clientSideToolV2 = new ClientSideToolV2Producer();
  readonly sendPipeline = new SendPipeline(this);
  readonly turnRuntime = new TurnRuntime(this);
  readonly runnerRegistry = new RunnerRegistry(this);
  readonly sessions = new SessionRuntime(this);
  readonly runLifecycle = new RunLifecycle(this);
  readonly roster = new RosterProjection(this);
  readonly agentLifecycle = new AgentLifecycle(this);
  readonly groupChat = new GroupChatGlue(this);
  readonly sharedRooms = new SharedRooms(this);
  readonly backgroundWakes = new BackgroundWakes(this);
  readonly pendingWakes = new PendingWakeRearm(this);
  readonly ackObligations = new AckObligations(this);
  readonly upgradeResume = new UpgradeRecreateResume(this);
  readonly boxHandoff = new BoxHandoffResume(this);
  readonly automationRuntime = new AutomationRuntime(this);
  readonly workflowCommands = new WorkflowCommands(this);
  readonly widgetResponses = new WidgetResponses(this);
  readonly entryDeletion = new TranscriptEntryDeletion(this);

  memory: any = NO_MEMORY;
  contentSearch: any = NO_CONTENT_SEARCH;
  execution: TurnExecutionPort = UNWIRED_TURN_EXECUTION;
  trayErrors: any = NO_TRAY_ERRORS;
  attachments: any = NOOP_TRANSCRIPT_ATTACHMENTS;
  channelDelivery: (...args: any[]) => Promise<any> = async () => {
    throw new SandChannelDeliveryUnregisteredError();
  };
  xuserDelegate: any = null;
  channelActivity: ((...args: any[]) => unknown) | undefined;
  channelConfigChanged: (() => unknown) | undefined;
  automationConfigChanged: (() => unknown) | undefined;
  shouldEmitAutomations = () => true;
  disposed = false;
  telemetry: any = createNoopSandTelemetry();
  productAnalytics: any = createNoopSandProductAnalytics();
  traceFlusher = () => {};
  foreverBox: any = EMPTY_FOREVER_BOX;
  onAgentForgotten: ((agentId: string) => unknown) | undefined;
  onListenerConnectCard: ((event: any) => unknown) | undefined;
  onConnectorConnectCard: ((event: any) => unknown) | undefined;
  agentRunLifecycleObserver: ((event: any) => unknown) | undefined;

  constructor(
    readonly sessionStore: any,
    readonly upgradeResumeStore: any,
    readonly ackObligationStore: any,
    readonly acceptanceLedger: PromptAcceptanceLedger = new PromptAcceptanceLedger(
      null,
    ),
    readonly pendingWakeStore?: any,
    readonly taskBoundary: TaskBoundary = createTranscriptTaskBoundary(),
    readonly ackRedrivePolicy: ExpiryPolicy = createExpiryPolicy(realClock, {
      name: "transcript.ack-redrive",
      ttlMs: ACK_REDRIVE_IDLE_DELAY_MS,
    }),
    readonly clock: Clock = realClock,
  ) {
    this.sessionStore.setBeingDeletedPredicate?.((id: string) =>
      this.sessions.deletedAgentIds.has(id),
    );
    void this.sessionStore.cleanupLegacyGroupMemberDirs?.();
  }

  setAgentForgottenObserver(observer: (id: string) => unknown): void {
    this.onAgentForgotten = observer;
  }
  setListenerConnectObserver(observer: (event: any) => unknown): void {
    this.onListenerConnectCard = observer;
  }
  setConnectorConnectCardObserver(observer: (event: any) => unknown): void {
    this.onConnectorConnectCard = observer;
  }
  setAgentRunLifecycleObserver(observer: (event: any) => unknown): void {
    this.agentRunLifecycleObserver = observer;
  }
  emitAgentRunLifecycle(event: any): void {
    this.agentRunLifecycleObserver?.(event);
  }
  setTurnExecution(execution: TurnExecutionPort): void {
    this.execution = execution;
  }
  setTelemetry(telemetry: any): void {
    this.telemetry = telemetry;
  }
  setProductAnalytics(analytics: any): void {
    this.productAnalytics = analytics;
  }
  setTraceFlusher(flush: () => void): void {
    this.traceFlusher = flush;
  }
  setForeverBox(foreverBox: any): void {
    this.foreverBox = foreverBox;
  }
  setTrayErrors(trays: any): void {
    this.trayErrors = trays;
  }
  setAttachments(attachments: any): void {
    this.attachments = attachments;
  }
  setMemory(memory: any): void {
    this.memory = memory;
    this.sessionStore.setMemory(memory);
  }
  setContentSearch(contentSearch: any): void {
    this.contentSearch = contentSearch;
  }
  setChannelDelivery(deliver: (...args: any[]) => Promise<any>): void {
    this.channelDelivery = deliver;
  }
  setChannelActivity(notify: (...args: any[]) => unknown): void {
    this.channelActivity = notify;
  }
  setChannelConfigChanged(onChanged: () => unknown): void {
    this.channelConfigChanged = onChanged;
  }
  setAutomationConfigChanged(onChanged: () => unknown): void {
    this.automationConfigChanged = onChanged;
  }
  setShouldEmitAutomations(shouldEmit: () => boolean): void {
    this.shouldEmitAutomations = shouldEmit;
  }
  setXuserDelegate(delegate: any): void {
    this.xuserDelegate = delegate;
  }

  createAttachmentIngestor(
    session: LiveTranscriptSession,
  ): (sourcePath: string) => Promise<string> {
    return async (sourcePath) =>
      (await this.attachments.ingest(dirname(session.dbPath), sourcePath))
        .absolutePath;
  }

  createAssetImagePersister(session: LiveTranscriptSession) {
    return async (data: Uint8Array, mimeType: string) => {
      try {
        return await this.attachments.persistImageBytes(
          getAgentAssetsDir(dirname(session.dbPath)),
          data,
          mimeType,
        );
      } catch {
        return null;
      }
    };
  }

  createMediaBytesPersister(session: LiveTranscriptSession) {
    return async (
      filename: string,
      data: Uint8Array,
    ): Promise<string | null> => {
      try {
        return pathToFileURL(
          (
            await this.attachments.ingestBytes(
              dirname(session.dbPath),
              filename,
              data,
            )
          ).absolutePath,
        ).href;
      } catch {
        return null;
      }
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([this.sessions.windowedActivationTail]);
    (this.boxHandoff as any).foreverBoxListeners?.clear?.();
    (this.boxHandoff as any).boxHandoffs?.clear?.();
    this.acceptanceLedger.dispose();
    this.runLifecycle.runScheduler?.dispose();
    for (const armed of this.ackObligations.ackRedriveTimers.values())
      armed.dispose();
    this.ackObligations.ackRedriveTimers.clear();
    this.ackObligations.ackRunTokens.clear();
    for (const batch of this.automationRuntime.pendingEventFireBatches.values()) {
      if (batch.timer != null) clearTimeout(batch.timer);
      for (const item of batch.items) item.resolve(undefined);
    }
    this.automationRuntime.pendingEventFireBatches.clear();
    this.unwatchActiveSession();
    invoke(this.roster, "stopOutlineStreamCoalescing", []);
    for (const runner of this.runnerRegistry.runners.values())
      runner.cancelBackgroundShellRewatches?.();
    this.runnerRegistry.runners.clear();
    for (const runner of this.runnerRegistry.activeGroupMemberRunners.values())
      runner.cancelBackgroundShellRewatches?.();
    this.runnerRegistry.activeGroupMemberRunners.clear();
    const sessions = new Set(this.sessions.liveSessions.values());
    if (this.sessions.activeSession != null)
      sessions.add(this.sessions.activeSession);
    this.sessions.liveSessions.clear();
    for (const pending of this.sessions.pendingSessionOpens.values()) {
      const settled = await this.sessions.settledOpen(pending);
      if (settled != null) sessions.add(settled);
    }
    this.sessions.pendingSessionOpens.clear();
    for (const session of sessions) {
      await session.agentStore?.dispose();
      session.db.close?.({ checkpoint: true });
    }
    await this.sessionStore.closeWorkerPool?.();
  }

  async getAgentMemories(agentId: string) {
    return this.memory.list({ agentId });
  }
  async deleteAgentMemory(agentId: string, memoryId: string) {
    const result = await this.memory.remove({ agentId, memoryId });
    await this.clearMemoryPromptSnapshot(agentId);
    return result;
  }
  async clearAgentMemories(agentId: string) {
    const result = await this.memory.clear({ agentId });
    await this.clearMemoryPromptSnapshot(agentId);
    return result;
  }
  async clearMemoryPromptSnapshot(agentId: string): Promise<void> {
    const active = this.sessions.activeSession;
    if (active?.id === agentId) active.db.clearMemoryPromptSnapshot();
    else await this.sessionStore.clearAgentMemoryPromptSnapshot(agentId);
  }
  getAgentChannels(agentId: string) {
    return this.sessionStore.listAgentChannels(agentId);
  }
  listAgentIds() {
    return this.sessionStore.listAgentIds();
  }
  listChannelConfigs(agentId: string) {
    return this.sessionStore.listChannelConfigs(agentId);
  }
  getAgentAvatarPng(agentId: string) {
    return this.sessionStore.getAgentAvatarPng(agentId);
  }
  getAgentProfileText(agentId: string) {
    return this.sessionStore.getAgentProfileText(agentId);
  }
  connectChannel(agentId: string, platform: string, token: string): boolean {
    const value = token.trim();
    return (
      value.length > 0 &&
      this.sessionStore.storeConnectorCredential(
        agentId,
        platform,
        "token",
        value,
      )
    );
  }
  disconnectChannel(agentId: string, platform: string) {
    return this.sessionStore.disconnectChannel(agentId, platform);
  }

  promptAcceptanceStatus(...args: any[]) {
    return invoke(this.sendPipeline, "promptAcceptanceStatus", args);
  }
  sendPrompt(...args: any[]) {
    return invoke(this.sendPipeline, "sendPrompt", args);
  }
  resolveBoxRequestEntry(...args: any[]) {
    return invoke(this.sendPipeline, "resolveBoxRequestEntry", args);
  }
  devAppendSendMessage(...args: any[]) {
    return invoke(this.sendPipeline, "devAppendSendMessage", args);
  }
  appendConnectorCard(...args: any[]) {
    return invoke(this.sendPipeline, "appendConnectorCard", args);
  }
  handleAgentUpdate(...args: any[]) {
    return invoke(this.turnRuntime, "handleAgentUpdate", args);
  }
  attachRunner(...args: any[]) {
    return invoke(this.runnerRegistry, "attachRunner", args);
  }
  attachRunnerFactory(...args: any[]) {
    return invoke(this.runnerRegistry, "attachRunnerFactory", args);
  }
  attachGroupMemberRunnerFactory(...args: any[]) {
    return invoke(this.runnerRegistry, "attachGroupMemberRunnerFactory", args);
  }
  attachRunReadinessProbe(...args: any[]) {
    return invoke(this.runnerRegistry, "attachRunReadinessProbe", args);
  }

  getActiveAgentDir(...args: any[]) {
    return invoke(this.sessions, "getActiveAgentDir", args);
  }
  ensureLoaded(...args: any[]) {
    return invoke(this.sessions, "ensureLoaded", args);
  }
  getEntries(...args: any[]) {
    return invoke(this.sessions, "getEntries", args);
  }
  appendEntry(...args: any[]) {
    return invoke(this.sessions, "appendEntry", args);
  }
  setWindowFocused(...args: any[]) {
    return invoke(this.sessions, "setWindowFocused", args);
  }
  getActiveAgentId(...args: any[]) {
    return invoke(this.sessions, "getActiveAgentId", args);
  }
  getWindowFocusedAtMs(...args: any[]) {
    return invoke(this.sessions, "getWindowFocusedAtMs", args);
  }
  noteDesktopContact(...args: any[]) {
    return invoke(this.sessions, "noteDesktopContact", args);
  }
  switchAgent(...args: any[]) {
    return invoke(this.sessions, "switchAgent", args);
  }
  openAgentWindowed(...args: any[]) {
    return invoke(this.sessions, "openAgentWindowed", args);
  }
  openAgentTail(...args: any[]) {
    return invoke(this.sessions, "openAgentTail", args);
  }
  getAgentTranscriptWindow(...args: any[]) {
    return invoke(this.sessions, "getAgentTranscriptWindow", args);
  }
  getAgentTranscriptTail(...args: any[]) {
    return invoke(this.sessions, "getAgentTranscriptTail", args);
  }
  getAgentThread(...args: any[]) {
    return invoke(this.sessions, "getAgentThread", args);
  }
  getAgentTranscript(...args: any[]) {
    return invoke(this.sessions, "getAgentTranscript", args);
  }
  getAgentTranscriptPage(...args: any[]) {
    return invoke(this.sessions, "getAgentTranscriptPage", args);
  }

  getRunQueueDiagnostics(...args: any[]) {
    return invoke(this.runLifecycle, "getRunQueueDiagnostics", args);
  }
  liveRunningAgentIds(...args: any[]) {
    return invoke(this.runLifecycle, "liveRunningAgentIds", args);
  }
  hasAgentsWithRunningSubagents(): boolean {
    return (
      (
        invoke(this.roster, "liveSubagentParentIds", []) as
          Set<string> | undefined
      )?.size! > 0
    );
  }

  unwatchActiveSession(): void {
    this.memory.setActiveAgent(null);
    const automation = this.automationRuntime as any;
    automation.watchedAutomations?.setOnChange(undefined);
    automation.watchedAutomations = undefined;
    const workflows = this.workflowCommands as any;
    workflows.watchedWorkflows?.setOnChange(undefined);
    workflows.watchedWorkflows = undefined;
    invoke(this.roster, "stopWatchingProfile", []);
  }
}

const delegations: ReadonlyArray<[string, keyof TranscriptManager]> = [
  ["listAgents", "roster"],
  ["countAgentsOnDisk", "roster"],
  ["isAgentCapReached", "roster"],
  ["searchAgents", "roster"],
  ["searchMedia", "roster"],
  ["listAgentsSync", "roster"],
  ["subscribeAgents", "roster"],
  ["subscribeAgentUpserted", "roster"],
  ["subscribeProfileChanged", "roster"],
  ["getAgentDisplayProfile", "roster"],
  ["subscribe", "roster"],
  ["subscribeOutline", "roster"],
  ["subscribeSubagents", "roster"],
  ["subscribeAsyncTasks", "roster"],
  ["subscribeClientSideToolV2", "roster"],
  ["getSubagents", "roster"],
  ["getAsyncTasks", "roster"],
  ["getConversationOutline", "roster"],
  ["createAgent", "agentLifecycle"],
  ["createBackgroundAgent", "agentLifecycle"],
  ["kickstartAgent", "agentLifecycle"],
  ["requestDiskSaverAudit", "agentLifecycle"],
  ["cloneAgent", "agentLifecycle"],
  ["deleteAgent", "agentLifecycle"],
  ["deleteAgents", "agentLifecycle"],
  ["updateAgent", "agentLifecycle"],
  ["setAgentUnread", "agentLifecycle"],
  ["setAgentNotifyOnUpdates", "agentLifecycle"],
  ["setAgentHiddenFromSidebar", "agentLifecycle"],
  ["setAgentAvatarBytes", "agentLifecycle"],
  ["getAgentAvatar", "agentLifecycle"],
  ["createGroup", "groupChat"],
  ["setGroupMembers", "groupChat"],
  ["postToGroup", "sharedRooms"],
  ["findRoomAgentId", "sharedRooms"],
  ["listRoomAgentIds", "sharedRooms"],
  ["getSharedRoomIdForAgent", "sharedRooms"],
  ["ensureHostedSharedRoom", "sharedRooms"],
  ["ensureMirrorRoom", "sharedRooms"],
  ["markMirrorRoomRevoked", "sharedRooms"],
  ["appendSharedRoomActivityNotice", "sharedRooms"],
  ["appendMirrorRoomEntry", "sharedRooms"],
  ["restampRoomEntry", "sharedRooms"],
  ["postSharedRoomGuestMessage", "sharedRooms"],
  ["runRemoteRequestedMemberTurn", "sharedRooms"],
  ["wakeForInbound", "backgroundWakes"],
  ["sendToAgent", "backgroundWakes"],
  ["broadcastToAgents", "backgroundWakes"],
  ["emitTimelineEvent", "backgroundWakes"],
  ["hasRunningBackgroundShellWork", "backgroundWakes"],
  ["rearmPendingWakes", "pendingWakes"],
  ["redriveUnfulfilledAckObligations", "ackObligations"],
  ["quiesceForUpgrade", "upgradeResume"],
  ["isQuiescingForUpgrade", "upgradeResume"],
  ["markAllRunningAgentsForUpgradeResume", "upgradeResume"],
  ["resumeInterruptedUpgradeTurns", "upgradeResume"],
  ["quiesceForRecreate", "upgradeResume"],
  ["hasCarryablePendingWake", "upgradeResume"],
  ["hasMidDrainRevival", "upgradeResume"],
  ["resumeAfterRecreate", "upgradeResume"],
  ["subscribeForeverBox", "boxHandoff"],
  ["withBoxHandoff", "boxHandoff"],
  ["createAwaitingStateSink", "boxHandoff"],
  ["handBackForeverBox", "boxHandoff"],
  ["emitForeverBoxStatus", "boxHandoff"],
  ["resumeAfterBoxHandoff", "boxHandoff"],
  ["resumeAfterMcpAuth", "boxHandoff"],
  ["resumeAfterListenerConnect", "boxHandoff"],
  ["subscribeAutomations", "automationRuntime"],
  ["getAgentAutomations", "automationRuntime"],
  ["listAllAutomations", "automationRuntime"],
  ["listAllAutomationDefinitions", "automationRuntime"],
  ["setAgentAutomationEnabled", "automationRuntime"],
  ["createAgentAutomation", "automationRuntime"],
  ["updateAgentAutomation", "automationRuntime"],
  ["deleteAgentAutomation", "automationRuntime"],
  ["runAgentAutomationNow", "automationRuntime"],
  ["runServerScheduledAutomation", "automationRuntime"],
  ["runAutomationForEvent", "automationRuntime"],
  ["runServerAutomationForEvent", "automationRuntime"],
  ["subscribeWorkflows", "workflowCommands"],
  ["getAgentWorkflows", "workflowCommands"],
  ["createAgentWorkflow", "workflowCommands"],
  ["updateAgentWorkflow", "workflowCommands"],
  ["setAgentWorkflowEnabled", "workflowCommands"],
  ["deleteAgentWorkflow", "workflowCommands"],
  ["importAgentWorkflowMarkdown", "workflowCommands"],
  ["importAgentWorkflowSource", "workflowCommands"],
  ["importAgentWorkflowUrl", "workflowCommands"],
  ["portAgentLocalSkills", "workflowCommands"],
  ["runAgentWorkflowNow", "workflowCommands"],
  ["respondToWidget", "widgetResponses"],
  ["settleStaleAutoReviewCard", "widgetResponses"],
  ["expireAllPendingAutoReviewApprovalCards", "widgetResponses"],
  ["dismissWidget", "widgetResponses"],
  ["submitSecret", "widgetResponses"],
  ["reactToMessage", "widgetResponses"],
  ["deleteTranscriptEntries", "entryDeletion"],
];

for (const [method, domain] of delegations) {
  Object.defineProperty(TranscriptManager.prototype, method, {
    value(this: TranscriptManager, ...args: any[]) {
      return invoke(this[domain], method, args);
    },
    configurable: true,
  });
}

export interface TranscriptManager extends Record<string, any> {}
