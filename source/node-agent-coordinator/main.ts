import { hostname } from "node:os";
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createRealExpiryPolicy, createRealPollingPolicy, createRealRetryPolicy, realClock } from "../internal/scheduling.js";
import { COORDINATOR_TRANSPORT_STATE_FAMILY } from "../shared/rpc/coordinator-port.js";
import { isCoordinatorMainMethod } from "../shared/rpc/coordinator-main.js";
import { SAND_WEBAUTHN_HEARTBEAT_INTERVAL_MS, type WebAuthnCeremony } from "../shared/webauthn-gateway.js";
import { adoptCarrier, type CarrierIntake } from "./carrier.js";
import { trustSystemCertificateAuthorities } from "../shared/node/trust-system-ca.js";
import { createControlPortClient } from "./control-port-client.js";
import { CoordinatorGatewayClient, HOST_ACCOUNT_SLOT, createCoordinatorGatewayClientTiming, type GatewayConnection } from "./gateway/gateway-client.js";
import { createGatewayDnsDiagnosticReporter } from "./gateway/gateway-dns-diagnostics.js";
import { coordinatorEventFamilyForSseChannel } from "./gateway/gateway-event-families.js";
import { createGatewayRequestDispatch } from "./gateway/gateway-request-dispatcher.js";
import { SandHostSupervisor, createCoordinatorHostSupervisorTiming } from "./gateway/host-supervisor.js";
import { createLocalExecDaemonRefreshPolicy, createLocalExecDaemonSupervisor } from "./local-exec/supervisor.js";
import { McpOAuthForwarder } from "./oauth/mcp-oauth-forwarder.js";
import { createRendererPortServer } from "./renderer-port-server.js";
import { createTransportStageRecorder, SSE_ECHO_MISSING_AFTER_MS } from "./telemetry/transport-stage-recorder.js";
import { createWebAuthnProvider } from "./webauthn/provider.js";
import { createSpawnedWebAuthnSigner, resolveWebAuthnSignerPath } from "./webauthn/signer.js";
import { ClientSideToolV2Relay } from "./client-side-tool-v2-relay.js";
import { createCoordinatorInferenceRouter } from "./inference-router.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";

function readCoordinatorSettings(dataDir: string): SandSettingsStore | null {
  try {
    return new SandSettingsStore(join(dataDir, "settings.json"));
  } catch {
    return null;
  }
}

/**
 * The OpenGrok server is the backend when it is the selected computer: it owns the
 * roster, the transcripts and inference, on each coworker's own model. Routing
 * locally would answer listAgents from this machine and the server's bots would
 * never appear - the app would look connected and show the wrong roster.
 */
let boxRuntimeCache: { path: string; stamp: string; value: string | null } | null = null;

export function readBoxRuntime(dataDir: string): string | null {
  const settingsPath = join(dataDir, "settings.json");
  let stamp: string;
  try {
    const stats = statSync(settingsPath);
    stamp = `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return readCoordinatorSettings(dataDir)?.getBoxRuntime() ?? null;
  }
  if (boxRuntimeCache?.path === settingsPath && boxRuntimeCache.stamp === stamp) return boxRuntimeCache.value;
  const value = readCoordinatorSettings(dataDir)?.getBoxRuntime() ?? null;
  boxRuntimeCache = { path: settingsPath, stamp, value };
  return value;
}

function usesOpenGrokServer(dataDir: string): boolean {
  return readBoxRuntime(dataDir) === "opengrok";
}

function usesLocalInference(dataDir: string): boolean {
  if (usesOpenGrokServer(dataDir)) return false;
  const provider = readCoordinatorSettings(dataDir)?.getInferenceProvider();
  return provider === "claude-code" || provider === "codex" || provider === "openrouter";
}

function usesLocalCoordinator(dataDir: string): boolean {
  if (usesOpenGrokServer(dataDir)) return false;
  const store = readCoordinatorSettings(dataDir);
  if (store?.getCursorLoginWallSkipped() === true) return true;
  return usesLocalInference(dataDir);
}

export interface McpOAuthPending {
  readonly serverName: string;
  readonly redirectUrl: string;
  readonly state: string;
}

export function asMcpOAuthPending(payload: unknown): McpOAuthPending | null {
  if (typeof payload !== "object" || payload == null) return null;
  const { serverName, redirectUrl, state } = payload as Record<string, unknown>;
  if (typeof serverName !== "string" || serverName.length === 0) return null;
  if (typeof redirectUrl !== "string" || redirectUrl.length === 0) return null;
  if (typeof state !== "string" || state.length === 0) return null;
  return { serverName, redirectUrl, state };
}

export function recordEchoIfUserEcho(payload: unknown, recorder: { recordSendEcho(key: { accountSlot: string; clientNonce: string }): void }): void {
  if (typeof payload !== "object" || payload == null) return;
  const event = payload as { readonly type?: unknown; readonly entry?: Record<string, unknown> };
  if (event.type !== "appended") return;
  const entry = event.entry;
  if (typeof entry?.clientNonce !== "string" || entry.clientNonce.length === 0) return;
  const isUserEcho = (entry.kind === "message" && entry.role === "user") || entry.kind === "user-attachment";
  if (isUserEcho) recorder.recordSendEcho({ accountSlot: HOST_ACCOUNT_SLOT, clientNonce: entry.clientNonce });
}

export function createWebAuthnReconnectPolicy() {
  return createRealRetryPolicy({ name: "sand-webauthn-reconnect", maxAttempts: Number.MAX_SAFE_INTEGER, initialDelayMs: 1_000, maxDelayMs: 30_000 });
}

type Commands = Record<string, (args: unknown) => Promise<unknown>>;

function command<T>(commands: Commands, method: string, args: unknown): Promise<T> {
  const invoke = commands[method];
  if (invoke === undefined) return Promise.reject(new Error(`control command ${method} is unavailable`));
  return invoke(args) as Promise<T>;
}

export interface ComposeCoordinatorDependencies {
  readonly adoptCarrier?: () => Promise<CarrierIntake>;
  readonly resolveSignerPath?: typeof resolveWebAuthnSignerPath;
}

export async function composeCoordinator(dependencies: ComposeCoordinatorDependencies = {}): Promise<void> {
  // Every gateway call and the /events stream leave this process over Node's TLS, which does
  // not read the OS keychain: trust the OS roots first. This is the production entry (the bundle
  // calls composeCoordinator directly), so it lives here and not behind the argv check below.
  const trusted = trustSystemCertificateAuthorities();
  if (trusted != null && trusted.system > 0) process.stderr.write(`node-agent-coordinator: trusting ${trusted.system} system CA roots alongside ${trusted.bundled} bundled\n`);
  const carrierIntake = await (dependencies.adoptCarrier ?? adoptCarrier)();
  if (!carrierIntake.adopted) {
    process.stderr.write(`node-agent-coordinator: ${carrierIntake.rejection.detail}\n`);
    process.exit(2);
  }
  const carrier = carrierIntake.carrier;
  const bootstrap = carrier.bootstrap;
  const controlClient = createControlPortClient({ post: (frame) => carrier.control.post(frame), close: () => carrier.control.close() });
  const commands = controlClient.commands;
  // A send whose echo never arrives is the stream lying about being up: tell the renderer the
  // transport is down (its own reconnecting state, no new UI), and force a fresh stream. The
  // renderer hears "connected" again from handleTransportEvent once the new stream is up.
  let onEchoMissing: (key: { accountSlot: string; clientNonce: string }) => void = () => {};
  const recorder = createTransportStageRecorder({
    clock: realClock,
    onEchoMissing: (key) => onEchoMissing(key),
    egress: {
      reportTransportStage: (report) => command(commands, "reportTransportStage", report),
      reportGatewayCommandSpan: (report) => command(commands, "reportGatewayCommandSpan", report),
      reportGatewayReachability: (report) => command(commands, "reportGatewayReachability", report),
      reportGatewayDnsDiagnostic: (report) => command(commands, "reportGatewayDnsDiagnostic", report)
    }
  });
  const dnsDiagnostics = createGatewayDnsDiagnosticReporter((report) => recorder.recordGatewayDnsDiagnostic(report));
  const reportReachability = (report: unknown, baseUrl?: string) => {
    recorder.recordGatewayReachability(report);
    dnsDiagnostics.observe(report as { outcome: string; causeSummary?: string }, baseUrl);
  };
  const dataDir = bootstrap.processConfig.dataDir;
  let isGatewayStreamLive = false;
  const hostSupervisor = new SandHostSupervisor({
    resolveGatewayConnection: () => command(commands, "resolveGatewayConnection", {}),
    timing: createCoordinatorHostSupervisorTiming(),
    isTransportLive: () => isGatewayStreamLive,
    onReachability: reportReachability
  });
  const oauthPendingHandlers = new Set<(pending: McpOAuthPending) => void>();
  let server: ReturnType<typeof createRendererPortServer>;
  let localExecSupervisor: ReturnType<typeof createLocalExecDaemonSupervisor>;
  let inferenceRouter: ReturnType<typeof createCoordinatorInferenceRouter> | undefined;
  const toolRelay = new ClientSideToolV2Relay((family, payload) => server.postEvent(family, payload));

  function handleGatewaySseEvent(event: { channel: string; payload: unknown }): void {
    if (event.channel === "mcp-oauth-pending") {
      const pending = asMcpOAuthPending(event.payload);
      if (pending != null) for (const handler of oauthPendingHandlers) handler(pending);
      return;
    }
    if (event.channel === "transcript") recordEchoIfUserEcho(event.payload, recorder);
    if (event.channel === "client-side-tool-v2") {
      toolRelay.accept(event.payload);
      return;
    }
    if ((event.channel === "agents" || event.channel === "agent-upserted") && usesLocalInference(dataDir)) return;
    if (event.channel === "agents") controlClient.postEvent("agents-event", { kind: "agents", event: event.payload });
    if (event.channel === "agent-upserted") controlClient.postEvent("agents-event", { kind: "agent-upserted", event: event.payload });
    const family = coordinatorEventFamilyForSseChannel(event.channel);
    if (family != null) server.postEvent(family, event.payload);
  }

  async function seedAgentsRosterToMain(): Promise<void> {
    try {
      if (usesLocalInference(dataDir) && inferenceRouter != null) {
        const routed = await inferenceRouter.dispatch("listAgents", {});
        if (routed.handled) {
          controlClient.postEvent("agents-roster-seed", { agents: routed.value });
          return;
        }
      }
      const agents = await gatewayClient.dispatchCommand("listAgents", {});
      controlClient.postEvent("agents-roster-seed", { agents });
    } catch (error) {
      process.stderr.write(`node-agent-coordinator: agents roster seed skipped: ${String(error)}\n`);
      // Without this the page never hears that the read failed, so it renders the roster it has —
      // nothing, on a fresh launch — and a server that cannot answer looks exactly like an account
      // with no bots. That is the worst way to fail: a database outage read as "your work is gone"
      // (2 Sep 2026). Saying the transport is down puts the reconnect notice and its Retry in front
      // of the person instead. It is posted after the caller's "connected", because that post is
      // synchronous and this catch is not, so the state the page keeps is this one. The next
      // transport event, or the retry, puts it back.
      if (!usesLocalCoordinator(dataDir)) server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" });
    }
  }

  function handleTransportEvent(raw: unknown): void {
    if (typeof raw !== "object" || raw == null) return;
    const event = raw as { family: string; payload: unknown };
    controlClient.postEvent(event.family, event.payload);
    if (event.family === "transport-down") {
      isGatewayStreamLive = false;
      hostSupervisor.invalidateHealthCache();
      if (!usesLocalCoordinator(dataDir)) {
        server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" });
      }
      return;
    }
    isGatewayStreamLive = true;
    void localExecSupervisor.refreshConnection();
    void seedAgentsRosterToMain();
    server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "connected" });
  }

  const gatewayClient = new CoordinatorGatewayClient({
    resolveConnection: (signal) => hostSupervisor.ensureConnection(signal) as Promise<GatewayConnection>,
    onEvent: handleGatewaySseEvent,
    onTransportEvent: handleTransportEvent,
    onTransportRetry: () => hostSupervisor.invalidateHealthCache(),
    recordTransportStage: (report) => recorder.recordTransportStage(report as Parameters<typeof recorder.recordTransportStage>[0]),
    onReachability: reportReachability,
    resolveTraceWindowTraceparent: () => command(commands, "getRpcTraceWindowTraceparent", {}),
    recordGatewayCommandSpan: (report) => recorder.recordGatewayCommandSpan(report),
    timing: createCoordinatorGatewayClientTiming()
  });

  const oauthForwarder = new McpOAuthForwarder({
    pendingEvents: {
      subscribe(handler) {
        oauthPendingHandlers.add(handler);
        return { dispose() { oauthPendingHandlers.delete(handler); } };
      }
    },
    completion: { completeMcpOAuth: (args) => gatewayClient.dispatchLegacyCommand("completeMcpOAuth", args) },
    log: { warn(warning) { process.stderr.write(`node-agent-coordinator: mcp-oauth ${JSON.stringify(warning)}\n`); } },
    pendingExpiry: createRealExpiryPolicy({ name: "mcp-oauth-pending", ttlMs: 10 * 60_000 })
  });

  localExecSupervisor = createLocalExecDaemonSupervisor({
    control: {
      resolveGatewayConnection: (args) => command(commands, "resolveGatewayConnection", args),
      mintLocalExecDaemonCredential: (args) => command(commands, "mintLocalExecDaemonCredential", args),
      spawnLocalExecDaemon: (args) => command(commands, "spawnLocalExecDaemon", args),
      isProcessAlive: (args) => command(commands, "isProcessAlive", args),
      getProcessIdentity: (args) => command(commands, "getProcessIdentity", args),
      waitLocalExecDaemonExit: (args) => command(commands, "waitLocalExecDaemonExit", args),
      terminateProcess: (args) => command(commands, "terminateProcess", args)
    },
    dataDir: bootstrap.processConfig.dataDir,
    isPackaged: bootstrap.processConfig.isPackaged,
    refreshPolicy: createLocalExecDaemonRefreshPolicy()
  });

  let webauthnProvider: ReturnType<typeof createWebAuthnProvider> | undefined;
  const signerPath = (dependencies.resolveSignerPath ?? resolveWebAuthnSignerPath)({ isPackaged: bootstrap.processConfig.isPackaged });
  if (signerPath !== undefined) {
    const reportProgress = (status: string) => { void command(commands, "updateWebAuthnConsent", { status }); };
    webauthnProvider = createWebAuthnProvider({
      resolveConnection: () => command(commands, "resolveGatewayConnection", {}),
      consent: {
        requestConsent: async (ceremony: WebAuthnCeremony) => {
          const optionsJson = ceremony.optionsJson;
          const options = typeof optionsJson === "string" ? JSON.parse(optionsJson) as { rpId?: string; rp?: { id?: string } } : {};
          return await command(commands, "requestWebAuthnConsent", { origin: ceremony.origin, rpId: options.rpId ?? options.rp?.id ?? ceremony.origin });
        },
        finish: () => { void command(commands, "finishWebAuthnConsent", {}); }
      },
      signer: createSpawnedWebAuthnSigner({
        binaryPath: signerPath,
        onStatus: reportProgress,
        onPinRequest: async (request, promptId) => {
          const result = await command<{ pin?: string | null }>(commands, "requestWebAuthnPin", { promptId, invalid: request.invalid, ...(request.retries === undefined ? {} : { retries: request.retries }) });
          return result.pin ?? undefined;
        }
      }),
      heartbeatPolicy: createRealPollingPolicy({ name: "sand-webauthn-heartbeat", intervalMs: SAND_WEBAUTHN_HEARTBEAT_INTERVAL_MS }),
      reconnectPolicy: createWebAuthnReconnectPolicy(),
      deliveryPolicy: createRealRetryPolicy({ name: "sand-webauthn-delivery", maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 4_000 }),
      label: hostname()
    });
    webauthnProvider.start();
  }

  const gatewayDispatch = createGatewayRequestDispatch(gatewayClient);
  inferenceRouter = createCoordinatorInferenceRouter({
    dataDir,
    postEvent: (family, payload) => server.postEvent(family, payload),
    dispatchRemote: (method, args) => method === "listRoutedMcpTools"
      ? command(commands, "listRoutedMcpTools", args)
      : method === "executeRoutedMcpTool"
        ? command(commands, "executeRoutedMcpTool", args)
        // Runs in the main process, which is the app bundle the user granted
        // Full Disk Access to. The coordinator is an Electron utility helper —
        // a separate signed bundle with no grant of its own — so reading
        // chat.db here would be denied.
        : method === "runMessagesOp"
          ? command(commands, "runMessagesOp", args)
          : gatewayClient.dispatchCommand(method, args),
  });
  const dispatchRequest = async (method: string, args: unknown, signal: AbortSignal) => {
    if (method === "sendPrompt" && typeof args === "object" && args != null) {
      const { clientNonce, traceparent } = args as Record<string, unknown>;
      recorder.beginSend({ accountSlot: HOST_ACCOUNT_SLOT, clientNonce: typeof clientNonce === "string" ? clientNonce : null, traceparent: typeof traceparent === "string" ? traceparent : null });
    }
      // In OpenGrok mode the server is the backend. The local router must not get
      // first refusal on the renderer's own requests, or it answers listAgents from
      // this machine and the server's coworkers never appear - the app looks
      // connected while showing the wrong roster.
      const routed = usesOpenGrokServer(dataDir)
        ? { handled: false as const, value: undefined }
        : await inferenceRouter!.dispatch(method, args);
    return routed.handled ? { status: "ok" as const, value: routed.value } : await gatewayDispatch(method, args, signal);
  };
  server = createRendererPortServer(
    { post: (frame) => carrier.data.post(frame), close: () => carrier.data.close() },
    { dispatchRequest, onServing: () => {
      toolRelay.replay();
      if (usesLocalCoordinator(dataDir)) {
        server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "connected" });
        void seedAgentsRosterToMain();
        return;
      }
      // Report the state the transport is actually in, not only the bad one.
        // transport-connected fires when the gateway stream comes up, which can be
        // before the renderer has claimed its port - a fast server on the LAN makes
        // that the common case rather than the rare one. Announcing only "down" here
        // left the renderer believing it was offline, so it never asked for a roster
        // and the sidebar stayed empty while the gateway was perfectly healthy.
        server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: isGatewayStreamLive ? "connected" : "down" });
    } }
  );
  onEchoMissing = (key) => {
    process.stderr.write(`node-agent-coordinator: no stream echo for send ${key.clientNonce} within ${SSE_ECHO_MISSING_AFTER_MS}ms; forcing a reconnect\n`);
    if (!usesLocalCoordinator(dataDir)) server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" });
    void gatewayClient.forceReconnect().catch(() => { /* closed or superseded: nothing to do */ });
  };
  const mainDispatch = createGatewayRequestDispatch(gatewayClient, isCoordinatorMainMethod);
  const applyPause = (paused: boolean) => {
    void localExecSupervisor.setPaused(paused);
    if (paused) webauthnProvider?.stop(); else webauthnProvider?.start();
  };
  const mainServer = createRendererPortServer(
    { post: (frame) => carrier.mainData.post(frame), close: () => carrier.mainData.close() },
    { dispatchRequest: async (method, args, signal) => {
      if (method === "setGatewayPaused" && typeof args === "object" && args != null) applyPause((args as Record<string, unknown>).paused === true);
        if (method === "clearAgentImageMetadata") {
          const routed = await inferenceRouter!.dispatch(method, args);
          if (routed.handled) return { status: "ok" as const, value: routed.value };
        }
      return mainDispatch(method, args, signal);
    } }
  );

  let exitSettled = false;
  function settleProcess(exitCode: number): void {
    if (exitSettled) return;
    exitSettled = true;
    recorder.dispose();
    gatewayClient.close();
    toolRelay.clear();
    localExecSupervisor.dispose();
    oauthForwarder.dispose();
    controlClient.shutdown();
    server.handlePortClosed();
    mainServer.handlePortClosed();
    carrier.control.close(); carrier.data.close(); carrier.mainData.close();
    carrier.exitProcess(exitCode);
  }
  void server.settled.then((settlement) => {
    if (settlement.outcome === "protocol-breach") { process.stderr.write(`node-agent-coordinator: protocol breach: ${settlement.detail}\n`); settleProcess(1); }
    else settleProcess(0);
  });
  void mainServer.settled.then((settlement) => {
    if (settlement.outcome === "protocol-breach") { process.stderr.write(`node-agent-coordinator: main-data protocol breach: ${settlement.detail}\n`); settleProcess(1); }
    else settleProcess(0);
  });
  void controlClient.settled.then((settlement) => {
    if (settlement.outcome === "protocol-breach") { process.stderr.write(`node-agent-coordinator: control protocol breach: ${settlement.detail}\n`); settleProcess(1); }
    else settleProcess(0);
  });
  const settleOnCrash = (kind: "uncaughtException" | "unhandledRejection", value: unknown) => {
    const error = value instanceof Error ? value : new Error(String(value));
    process.stderr.write(`node-agent-coordinator: ${kind}: ${error.stack ?? String(error)}\n`);
    void command(commands, "reportProcessCrash", { kind, errorName: error.name, errorMessage: error.message, errorStack: error.stack ?? null })
      .catch((reportError) => process.stderr.write(`node-agent-coordinator: crash report undelivered: ${String(reportError)}\n`));
    settleProcess(1);
  };
  process.on("uncaughtException", (value) => settleOnCrash("uncaughtException", value));
  process.on("unhandledRejection", (value) => settleOnCrash("unhandledRejection", value));
  carrier.bind({
    onControlFrame: (frame) => controlClient.handleMessage(frame),
    onDataFrame: (value) => server.handleMessage(value),
    onMainDataFrame: (value) => mainServer.handleMessage(value),
    onClosed: () => { controlClient.handlePortClosed(); server.handlePortClosed(); mainServer.handlePortClosed(); }
  });
  void localExecSupervisor.start();
  gatewayClient.start();
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void composeCoordinator().catch((error) => {
    process.stderr.write(`node-agent-coordinator: composition failure: ${String(error)}\n`);
    process.exit(1);
  });
}
