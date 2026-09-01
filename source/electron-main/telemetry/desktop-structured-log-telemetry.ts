import { randomBytes } from "node:crypto";
import { getLocalTelemetryLog } from "./local-telemetry-log.js";
import { desktopStructuredLogAccountSlotForToken, DESKTOP_STRUCTURED_LOG_SPILL_MAX_ENTRIES, emptyDesktopStructuredLogDropCounters, type DesktopStructuredLogSpill, type DesktopStructuredLogSpillState, type DropCounters, type StructuredLogCheckpoint, type StructuredLogLevel, type StructuredLogRecord, type TelemetryDropReason } from "./desktop-structured-log-spill.js";

export const DESKTOP_TELEMETRY_FLUSH_TICK_MS = 3_000;
export const STRUCTURED_LOG_SUBMIT_DEADLINE_MS = 15_000;
export const SAND_LOG_KEY = "sand";
export type TelemetryMetadata = Readonly<Record<string, string | undefined>>;

export class DesktopStructuredLogAccountIdentityError extends Error {
  constructor() { super("Desktop telemetry account identity is unavailable."); this.name = "DesktopStructuredLogAccountIdentityError"; }
}

export function requireDesktopStructuredLogAccessToken(options: { readonly accessToken: string; readonly currentAccountSlot: string | undefined }): string {
  if (options.currentAccountSlot === undefined || desktopStructuredLogAccountSlotForToken(options.accessToken) !== options.currentAccountSlot) throw new DesktopStructuredLogAccountIdentityError();
  return options.accessToken;
}
export function createDesktopStructuredLogAccessTokenResolver(options: { readonly getAccessToken: (request: unknown) => Promise<string>; readonly currentAccountSlot: () => string | undefined }) { return async (request: unknown): Promise<string> => requireDesktopStructuredLogAccessToken({ accessToken: await options.getAccessToken(request), currentAccountSlot: options.currentAccountSlot() }); }

export interface DesktopStructuredLogClient { submitLogs(records: readonly StructuredLogRecord[], options?: { readonly signal?: AbortSignal }): Promise<{ readonly logsProcessed: number; readonly logsDropped: number }> }
export interface DesktopStructuredLogTelemetryOptions {
  readonly machineId: string;
  readonly clientVersion: string;
  readonly appVersion?: string;
  readonly accountSlot?: string;
  readonly spill?: DesktopStructuredLogSpill;
  readonly createClient: () => DesktopStructuredLogClient;
  readonly createAnonymousClient: () => DesktopStructuredLogClient;
  readonly disabled?: boolean;
  readonly now?: () => number;
  readonly enablePolling?: boolean;
}

const EVENTS = {
  agentLoad: "sand.agent_load", boxSetupVisible: "sand.box_setup_visible", boxRecreateVisible: "sand.box_recreate_visible", boxRebuildStage: "sand.box_rebuild_stage", boxRebuildEscalation: "sand.box_rebuild_escalation", boxRebuildPendingStall: "sand.box_rebuild_pending_stall", boxMigrationWatch: "sand.box_migration_watch", boxSecretsPush: "sand.box_secrets.push", replicaResync: "sand.replica.resync", sendJournalRestore: "sand.send_journal.restore", resyncCompleted: "sand.resync.completed", boxReachability: "sand.box_reachability", boxDnsDiagnostic: "sand.box_dns_diagnostic", agentsUnreachable: "sand.agents_unreachable", accessBlocked: "sand.access_blocked", transportStreamDown: "sand.transport.stream_down", coordinatorLifecycle: "sand.desktop.coordinator_lifecycle", recoveryAction: "sand.recovery_action", vncSession: "sand.vnc_session", vncLiveness: "sand.vnc_liveness", vncAssetFail: "sand.vnc_asset_fail", attachmentEdge: "sand.attachment.edge_failed", imageEdge: "sand.image.edge_failed", mcpEdge: "sand.mcp.desktop_edge_failed", connectorAuth: "sand.connector_auth", telemetrySinkEdge: "sand.telemetry.sink_edge_failed", desktopEdge: "sand.desktop.edge_failed", startup: "sand.desktop.startup", eventLoop: "sand.desktop.event_loop", processCrash: "sand.desktop.process_crash", rendererLifecycle: "sand.desktop.renderer_lifecycle", coordinatorHandoff: "sand.desktop.coordinator_handoff", localExecLifecycle: "sand.desktop.local_exec_lifecycle", uncleanExit: "sand.desktop.unclean_exit", openComputer: "sand.open_computer", send: "sand.send", sendAck: "sand.send_ack", reactionAck: "sand.reaction.ack", renderTtfr: "sand.render_ttfr", renderStream: "sand.render_stream", updateOutcome: "sand.update.outcome", updateCheck: "sand.update.check", updatePrompt: "sand.update.prompt", updateApply: "sand.update.apply", signin: "sand.desktop.signin", session: "sand.desktop.session",
} as const;
const KNOWN_CONNECTOR_TAGS = new Set(["asana", "atlassian", "buildkite", "confluence", "context7", "databricks", "datadog", "deepwiki", "dock", "figma", "filesystem", "github", "gmail", "google", "googlecalendar", "googledocs", "googledrive", "googlesheets", "googleworkspace", "huggingface", "jira", "linear", "memory", "notion", "playwright", "salesforce", "sentry", "sequentialthinking", "slack", "stripe", "telegram", "todoist", "zoominfo"]);

function cloneCounters(counters: DropCounters): DropCounters { return Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, { ...value }])) as DropCounters; }
function counterId(): string { return randomBytes(16).toString("hex"); }
function cleaned(metadata: TelemetryMetadata): Record<string, string> { const result: Record<string, string> = {}; for (const [key, value] of Object.entries(metadata)) if (value !== undefined && value.length > 0) result[key] = value; return result; }

class BufferedTransport {
  private buffer: StructuredLogRecord[];
  private counters: DropCounters;
  private id: string;
  private flushListener: (() => Promise<void> | void) | undefined;
  private tickListener: (() => void) | undefined;
  private chain = Promise.resolve(false);
  private disposed = false;
  private client: DesktopStructuredLogClient | undefined;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly options: { readonly tags: Record<string, string>; readonly createClient: () => DesktopStructuredLogClient; readonly disabled: boolean; readonly now: () => number; readonly initial?: StructuredLogCheckpoint; readonly polling: boolean }) {
    this.buffer = options.initial?.records.slice(-DESKTOP_STRUCTURED_LOG_SPILL_MAX_ENTRIES).map((record) => ({ ...record, metadata: { ...record.metadata } })) ?? [];
    this.counters = options.initial === undefined ? emptyDesktopStructuredLogDropCounters() : cloneCounters(options.initial.counters);
    this.id = options.initial?.counterId ?? counterId();
    if (options.polling && !options.disabled) { this.timer = setInterval(() => { this.tickListener?.(); void this.flushNow(); }, DESKTOP_TELEMETRY_FLUSH_TICK_MS); this.timer.unref(); }
  }
  setFlushSettledListener(listener: () => Promise<void> | void): void { this.flushListener = listener; }
  setFlushTickListener(listener: (() => void) | undefined): void { this.tickListener = listener; }
  enqueue(level: StructuredLogLevel, message: string, metadata: TelemetryMetadata): void { this.enqueueAt(level, message, metadata, this.options.now()); }
  enqueueAt(level: StructuredLogLevel, message: string, metadata: TelemetryMetadata, timestamp: number): void { if (this.options.disabled || this.disposed) return; this.buffer.push({ level, message, metadata: { ...this.options.tags, ...cleaned(metadata) }, timestamp }); const overflow = this.buffer.length - DESKTOP_STRUCTURED_LOG_SPILL_MAX_ENTRIES; if (overflow > 0) { this.buffer.splice(0, overflow); this.recordDropped("overflow_evicted", overflow); } }
  recordDropped(reason: TelemetryDropReason, count: number): void { if (count <= 0) return; const pair = this.counters[reason]; pair.observed = Math.min(Number.MAX_SAFE_INTEGER, pair.observed + count); }
  captureCheckpoint(): StructuredLogCheckpoint { return { counterId: this.id, counters: cloneCounters(this.counters), records: this.buffer.map((record) => ({ ...record, metadata: { ...record.metadata } })) }; }
  async clearPending(): Promise<void> { this.buffer = []; this.counters = emptyDesktopStructuredLogDropCounters(); this.id = counterId(); await this.chain.catch(() => false); this.client = undefined; }
  flushNow(): Promise<boolean> { const run = this.chain.then(() => this.flushOnce(), () => this.flushOnce()); this.chain = run; return run; }
  private async flushOnce(): Promise<boolean> { if (this.options.disabled) return true; if (this.buffer.length === 0) { await this.flushListener?.(); return !this.pendingDrops(); } const batch = this.buffer.slice(); try { const client = this.client ?? (this.client = this.options.createClient()); const receipt = await client.submitLogs(batch); if (!Number.isSafeInteger(receipt.logsProcessed) || !Number.isSafeInteger(receipt.logsDropped) || receipt.logsProcessed + receipt.logsDropped !== batch.length) throw new TypeError("Invalid structured log receipt"); this.buffer.splice(0, batch.length); this.recordDropped("backend_dropped", receipt.logsDropped); await this.flushListener?.(); return this.buffer.length === 0; } catch { this.client = undefined; this.recordDropped("ship_failed", 1); await this.flushListener?.(); return false; } }
  private pendingDrops(): boolean { return Object.values(this.counters).some((pair) => pair.observed > pair.acknowledgedThrough); }
  async dispose(): Promise<boolean> { if (this.disposed) return this.buffer.length === 0; this.disposed = true; if (this.timer !== undefined) clearInterval(this.timer); return this.flushNow(); }
}

type EdgeFailure = { readonly leg: string; readonly errorClass: string };
type DesktopFailure = EdgeFailure & { readonly area: string };
type TransitionEntry = { readonly level: StructuredLogLevel; readonly event: string; readonly metadata: TelemetryMetadata; readonly timestamp: number };

export class SandDesktopStructuredLogTelemetry {
  private readonly accountTransport: BufferedTransport;
  private readonly anonymousSigninTransport: BufferedTransport;
  private readonly spill: DesktopStructuredLogSpill | undefined;
  private spillWritable: boolean;
  private spillOnDisk: boolean;
  private spillRevision = 0;
  private flushChain = Promise.resolve(true);
  private accountSlot: string | undefined;
  private accountTransition = Promise.resolve();
  private accountTransitionGeneration = 0;
  private accountTransitionEntries: TransitionEntry[] = [];
  private accountTransitionOverflow = 0;
  private accountTransitionPriorOverflow = 0;
  private accountTransitionDiscarded = 0;
  private accountReady = true;
  private readonly now: () => number;

  static async create(options: DesktopStructuredLogTelemetryOptions): Promise<SandDesktopStructuredLogTelemetry> {
    const disabled = options.disabled ?? process.env.SAND_DISABLE_TELEMETRY === "1";
    if (disabled) { await options.spill?.clear(); return new SandDesktopStructuredLogTelemetry({ ...options, disabled }); }
    let loaded: Awaited<ReturnType<DesktopStructuredLogSpill["load"]>> = { kind: "empty" };
    if (options.spill !== undefined && options.accountSlot !== undefined) loaded = await options.spill.load(options.accountSlot);
    const telemetry = new SandDesktopStructuredLogTelemetry(options, loaded.kind === "loaded" ? loaded.state : undefined, loaded.kind !== "failed" || loaded.preservesFile !== true, loaded.kind === "loaded" || loaded.kind === "failed" && loaded.preservesFile === true);
    if (loaded.kind === "loaded") void telemetry.flushNow();
    return telemetry;
  }

  private constructor(options: DesktopStructuredLogTelemetryOptions, loaded?: DesktopStructuredLogSpillState, spillWritable = true, spillOnDisk = false) {
    this.spill = options.spill; this.spillWritable = spillWritable; this.spillOnDisk = spillOnDisk; this.accountSlot = options.accountSlot; this.now = options.now ?? Date.now;
    const tags = { client: "sand", "client.type": "sand", "client.machine_id": options.machineId, client_version: options.clientVersion, app_version: options.appVersion ?? "0.18.0", arch: process.arch, platform: process.platform };
    const disabled = options.disabled ?? process.env.SAND_DISABLE_TELEMETRY === "1";
    this.accountTransport = new BufferedTransport({ tags, createClient: options.createClient, disabled, now: this.now, ...(loaded === undefined ? {} : { initial: loaded.checkpoint }), polling: options.enablePolling ?? true });
    this.accountTransport.setFlushSettledListener(() => this.syncSpillAfterTransportFlush());
    this.anonymousSigninTransport = new BufferedTransport({ tags, createClient: options.createAnonymousClient, disabled, now: this.now, polling: options.enablePolling ?? true });
  }

  private report(level: StructuredLogLevel, event: string, metadata: TelemetryMetadata): void { this.enqueue(level, event, metadata); }
  reportAgentLoad(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.agentLoad, m); } reportBoxSetupVisible(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.boxSetupVisible, m); } reportBoxRecreateVisible(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.boxRecreateVisible, m); } reportBoxRebuildStage(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.boxRebuildStage, m); } reportBoxRebuildEscalation(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.boxRebuildEscalation, m); } reportBoxRebuildPendingStall(m: TelemetryMetadata): void { this.report("warn", EVENTS.boxRebuildPendingStall, m); } reportBoxMigrationWatch(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.boxMigrationWatch, m); } reportBoxSecretsPush(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.boxSecretsPush, m); } reportReplicaResync(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.replicaResync, m); } reportSendJournalRestore(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.sendJournalRestore, m); } reportResyncCompleted(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.resyncCompleted, m); }
  reportBoxReachability(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.boxReachability, m); } reportBoxDnsDiagnostic(m: TelemetryMetadata): void { this.report("warn", EVENTS.boxDnsDiagnostic, m); } reportAgentsUnreachable(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.agentsUnreachable, m); } reportAccessBlocked(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.accessBlocked, m); } reportTransportStreamDown(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.transportStreamDown, m); } reportCoordinatorLifecycle(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.coordinatorLifecycle, m); } reportRecoveryAction(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.recoveryAction, m); } reportVncSession(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.vncSession, m); } reportVncLiveness(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.vncLiveness, m); } reportVncAssetFail(m: TelemetryMetadata): void { this.report("warn", EVENTS.vncAssetFail, m); }
  reportAttachmentEdgeFailure(f: EdgeFailure): void { this.report("warn", EVENTS.attachmentEdge, { leg: f.leg, error_class: f.errorClass }); } reportImageEdgeFailure(f: EdgeFailure): void { this.report("warn", EVENTS.imageEdge, { leg: f.leg, error_class: f.errorClass }); } reportMcpDesktopEdgeFailure(f: EdgeFailure): void { this.report("warn", EVENTS.mcpEdge, { leg: f.leg, error_class: f.errorClass }); } reportTelemetrySinkEdgeFailure(f: { sink: string; errorClass: string }): void { this.report("warn", EVENTS.telemetrySinkEdge, { sink: f.sink, error_class: f.errorClass }); } reportDesktopEdgeFailure(f: DesktopFailure): void { this.report("warn", EVENTS.desktopEdge, { area: f.area, leg: f.leg, error_class: f.errorClass }); }
  reportConnectorAuth(r: { phase: string; outcome: string; serverName?: string; serverId?: string; reauth?: boolean }): void { const normalized = r.serverName?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? ""; this.report(r.outcome === "failed" || r.outcome === "timeout" ? "warn" : "info", EVENTS.connectorAuth, { phase: r.phase, connector: normalized.length === 0 ? "unknown" : KNOWN_CONNECTOR_TAGS.has(normalized) ? normalized : "other", outcome: r.outcome, surface: "desktop", server_id: r.serverId, reauth: r.reauth === undefined ? undefined : String(r.reauth) }); }
  reportDesktopStartup(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.startup, m); } reportDesktopEventLoop(m: TelemetryMetadata): void { this.report("warn", EVENTS.eventLoop, m); } reportDesktopProcessCrash(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.processCrash, m); } reportDesktopRendererLifecycle(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.rendererLifecycle, m); } reportDesktopCoordinatorHandoff(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.coordinatorHandoff, m); } reportDesktopLocalExecLifecycle(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.localExecLifecycle, m); } reportDesktopUncleanExit(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.uncleanExit, m); } reportOpenComputer(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.openComputer, m); } reportSendLatency(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.send, m); } reportSendAck(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.sendAck, m); } reportReactionAck(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.reactionAck, m); } reportRenderTtfr(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.renderTtfr, m); } reportRenderStream(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.renderStream, m); } reportUpdateOutcome(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.updateOutcome, m); } reportUpdateCheck(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.updateCheck, m); } reportUpdatePrompt(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.updatePrompt, m); } reportUpdateApply(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.updateApply, m); } reportDesktopSession(l: StructuredLogLevel, m: TelemetryMetadata): void { this.report(l, EVENTS.session, m); }
  reportDesktopSignin(l: StructuredLogLevel, m: TelemetryMetadata): void { this.anonymousSigninTransport.enqueue(l, EVENTS.signin, m); }
  reportClientFailure(f: { level: StructuredLogLevel; event: string; metadata: TelemetryMetadata }): void { this.report(f.level, f.event, f.metadata); }
  setFlushTickListener(listener: (() => void) | undefined): void { this.accountTransport.setFlushTickListener(listener); }
  currentAccountSlot(): string | undefined { return this.accountSlot; }

  setAccountSlot(accountSlot: string | undefined): Promise<void> { if (accountSlot === undefined || this.spill === undefined || accountSlot === this.accountSlot) return this.accountTransition; this.accountSlot = accountSlot; this.spillRevision += 1; this.accountReady = false; this.accountTransitionDiscarded = Math.min(Number.MAX_SAFE_INTEGER, this.accountTransitionDiscarded + this.accountTransitionEntries.length); this.accountTransitionPriorOverflow = Math.min(Number.MAX_SAFE_INTEGER, this.accountTransitionPriorOverflow + this.accountTransitionOverflow); this.accountTransitionEntries = []; this.accountTransitionOverflow = 0; const generation = ++this.accountTransitionGeneration; const reset = async (): Promise<void> => { await this.accountTransport.clearPending(); if (this.spillWritable && this.spill !== undefined) { const cleared = await this.spill.clear(); if (cleared.kind === "empty") this.spillOnDisk = false; } if (generation !== this.accountTransitionGeneration) return; const entries = this.accountTransitionEntries; const overflow = Math.min(Number.MAX_SAFE_INTEGER, this.accountTransitionOverflow + this.accountTransitionPriorOverflow); const rotated = this.accountTransitionDiscarded; this.accountTransitionEntries = []; this.accountTransitionOverflow = 0; this.accountTransitionPriorOverflow = 0; this.accountTransitionDiscarded = 0; if (overflow > 0) this.accountTransport.recordDropped("overflow_evicted", overflow); if (rotated > 0) this.accountTransport.recordDropped("account_rotated", rotated); this.accountReady = true; for (const entry of entries) this.accountTransport.enqueueAt(entry.level, entry.event, entry.metadata, entry.timestamp); }; this.accountTransition = this.accountTransition.then(reset, reset); return this.accountTransition; }
  flushNow(): Promise<boolean> { const run = this.flushChain.then(() => this.flushOnce(), () => this.flushOnce()); this.flushChain = run; return run; }
  private async flushOnce(): Promise<boolean> { await this.accountTransition; const generation = this.accountTransitionGeneration; this.spillRevision += 1; const revision = this.spillRevision; const [accountDrained, anonymousDrained] = await Promise.all([this.accountTransport.flushNow(), this.anonymousSigninTransport.flushNow()]); if (generation !== this.accountTransitionGeneration) return this.flushOnce(); if (!this.spillWritable || this.spill === undefined || this.accountSlot === undefined) return accountDrained && anonymousDrained; if (!accountDrained) { await this.spillPending(); return false; } if (!this.spillOnDisk) return anonymousDrained; if (revision !== this.spillRevision) { await this.spillPending(); return false; } const cleared = await this.spill.clear(); if (cleared.kind === "empty") this.spillOnDisk = false; return cleared.kind === "empty" && anonymousDrained; }
  private async spillPending(): Promise<void> { await this.accountTransition; this.spillRevision += 1; if (!this.spillWritable || this.spill === undefined || this.accountSlot === undefined) return; this.spillOnDisk = true; await this.replaceSpill(); }
  private async syncSpillAfterTransportFlush(): Promise<void> { if (!this.spillOnDisk || !this.spillWritable || !this.accountReady || this.spill === undefined || this.accountSlot === undefined) return; await this.replaceSpill(); }
  private async replaceSpill(): Promise<void> { if (this.spill === undefined || this.accountSlot === undefined) return; const result = await this.spill.replace({ accountSlot: this.accountSlot, checkpoint: this.accountTransport.captureCheckpoint() }); if (result.kind === "stored") this.spillOnDisk = true; if (result.kind === "empty") this.spillOnDisk = false; }
  async dispose(): Promise<void> { await this.accountTransition; await this.flushChain; await this.spillPending(); const revision = this.spillRevision; const [drained] = await Promise.all([this.accountTransport.dispose(), this.anonymousSigninTransport.dispose()]); if (drained && revision === this.spillRevision && this.spillWritable && this.spill !== undefined) { const cleared = await this.spill.clear(); if (cleared.kind === "empty") this.spillOnDisk = false; return; } await this.spillPending(); }
  private enqueue(level: StructuredLogLevel, event: string, metadata: TelemetryMetadata): void { getLocalTelemetryLog()?.append(level, event, metadata); if (this.spillWritable) this.spillRevision += 1; if (!this.accountReady) { this.accountTransitionEntries.push({ level, event, metadata: { ...metadata }, timestamp: this.now() }); if (this.accountTransitionEntries.length > DESKTOP_STRUCTURED_LOG_SPILL_MAX_ENTRIES) { this.accountTransitionEntries.shift(); this.accountTransitionOverflow = Math.min(Number.MAX_SAFE_INTEGER, this.accountTransitionOverflow + 1); } return; } this.accountTransport.enqueue(level, event, metadata); }
}

export function createDesktopStructuredLogAccountSlotProvider(initialAccountSlot: string | undefined) { let telemetry: { currentAccountSlot(): string | undefined } | undefined; return { currentAccountSlot: (): string | undefined => telemetry?.currentAccountSlot() ?? initialAccountSlot, attach(value: { currentAccountSlot(): string | undefined }): void { telemetry = value; } }; }
