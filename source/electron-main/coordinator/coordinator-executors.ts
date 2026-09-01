import { randomUUID } from "node:crypto";
import { getLocalTelemetryLog } from "../telemetry/local-telemetry-log.js";
import { withOpenGrokDaemonToken, type OpenGrokDaemonIdentity } from "../box/opengrok-daemon-descriptor.js";
import { askpassDaemonEnvironment } from "../askpass/askpass-runtime.js";

import {
  clearLocalExecDaemonDiscoveryIfMatches,
  getLocalExecDaemonDiscoveryPath,
  readLocalExecDaemonDiscovery,
  type LocalExecDiscovery,
} from "../../host/local-exec/local-exec-daemon-protocol.js";

import {
  isProcessAlive,
  readProcessIdentity,
  resolveLocalExecDaemonEntryRealpath,
  spawnLocalExecDaemon,
  terminateProcess,
} from "../local-exec/local-exec-native.js";
import {
  commandCarriesLocalExecGeneration,
  localExecDiscoveryTimeMatchesProcess,
  sameLocalExecProcessIdentity,
  type ExpectedLocalExecProcessIdentity,
  type LocalExecProcessIdentity,
} from "../../shared/local-exec-process-identity.js";

export interface WebAuthnPromptWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly resizable: boolean;
  readonly minimizable: boolean;
  readonly maximizable: boolean;
  readonly alwaysOnTop: boolean;
  readonly title: string;
  readonly webPreferences: {
    readonly nodeIntegration: boolean;
    readonly contextIsolation: boolean;
  };
}

export interface WebAuthnPromptWindow {
  readonly webContents: {
    executeJavaScript(script: string, userGesture: boolean): Promise<unknown>;
  };
  loadURL(url: string): Promise<void>;
  once(event: "closed", listener: () => void): void;
  isDestroyed(): boolean;
  destroy(): void;
  getNativeWindowHandle(): Buffer;
}

export interface WebAuthnConsentRequest {
  readonly origin: string;
  readonly rpId: string;
}

export interface WebAuthnPinRequest {
  readonly promptId: string;
  readonly invalid: boolean;
  readonly retries?: number;
}

export type WebAuthnConsentResult =
  | { readonly approved: false; readonly promptId: null }
  | {
      readonly approved: true;
      readonly promptId: string;
      readonly windowHandle: number | undefined;
    };

export interface WebAuthnPromptController {
  requestConsent(args: WebAuthnConsentRequest): Promise<WebAuthnConsentResult>;
  requestPin(request: WebAuthnPinRequest): Promise<{ readonly pin: string | null }>;
  update(status: string): void;
  finish(): void;
}

export interface WebAuthnPromptDependencies {
  readonly createWindow: (options: WebAuthnPromptWindowOptions) => WebAuthnPromptWindow;
  readonly randomUUID?: () => string;
  readonly platform?: NodeJS.Platform;
}

export interface CoordinatorGatewayConnector {
  connect(): unknown | Promise<unknown>;
  issueLocalExecDaemonCredential?(): unknown | Promise<unknown>;
}

export interface CoordinatorTransportStageReport {
  readonly stage: string;
  readonly traceparent: string | null;
  readonly clientNonce: string;
  readonly startEpochMs: number;
  readonly durationMs: number;
  readonly attempt: number;
  readonly isError: boolean;
  readonly [key: string]: unknown;
}

export interface CoordinatorControlExecutorDependencies {
  readonly connector: CoordinatorGatewayConnector;
  readonly webauthnPrompt: WebAuthnPromptController;
  readonly recordSendStage: (report: {
    readonly name: string;
    readonly traceparent: string;
    readonly clientNonce: string;
    readonly startEpochMs: number;
    readonly durationMs: number;
    readonly attributes: { readonly "sand.attempt": number };
    readonly isError: boolean;
  }) => void;
  readonly recordGatewayCommandSpan: (report: unknown) => void;
  readonly onReachability: (report: unknown) => void;
  readonly onDnsDiagnostic: (report: unknown) => void;
  readonly onProcessCrash: (report: unknown) => void;
  readonly getRpcTraceWindowTraceparent?: () => string | undefined;
  readonly listRoutedMcpTools?: () => Promise<unknown>;
  readonly executeRoutedMcpTool?: (request: unknown) => Promise<unknown>;
  readonly runMessagesOp?: (op: unknown) => Promise<unknown>;
  readonly readOpenGrokDaemonIdentity?: () => Promise<OpenGrokDaemonIdentity>;
  readonly readLocalExecDaemonDiscovery?: () => Promise<LocalExecDiscovery | null>;
  readonly clearLocalExecDaemonDiscoveryIfMatches?: (expected: LocalExecDiscovery) => Promise<boolean>;
  readonly native?: {
    readonly spawnLocalExecDaemon: typeof spawnLocalExecDaemon;
    readonly terminateProcess: typeof terminateProcess;
    readonly isProcessAlive: typeof isProcessAlive;
    readonly readProcessIdentity: typeof readProcessIdentity;
    readonly resolveLocalExecDaemonEntryRealpath?: typeof resolveLocalExecDaemonEntryRealpath;
  };
}

const PROMPT_WINDOW_OPTIONS: WebAuthnPromptWindowOptions = {
  width: 420,
  height: 300,
  resizable: false,
  minimizable: false,
  maximizable: false,
  alwaysOnTop: true,
  title: "Security key request",
  webPreferences: { nodeIntegration: false, contextIsolation: true },
};

function windowsDialogParentHandle(
  window: WebAuthnPromptWindow,
  platform: NodeJS.Platform,
): number | undefined {
  if (platform !== "win32" || window.isDestroyed()) return undefined;
  const handle = window.getNativeWindowHandle();
  return handle.length >= 8
    ? Number(handle.readBigUInt64LE(0))
    : handle.readUInt32LE(0);
}

function renderPrompt(origin: string, rpId: string): string {
  const safeOrigin = JSON.stringify(origin);
  const safeRpId = JSON.stringify(rpId);
  return `<!doctype html>
<meta charset="utf-8" />
<style>
	:root {
		--sand-bg-base: #fcfcfc;
		--sand-bg-subtle: #f7f7f7;
		--sand-text-primary: #141414;
		--sand-text-secondary: #14141499;
		--sand-text-on-primary: #fcfcfc;
		--sand-border-default: #14141426;
		--sand-border-strong: #1414144d;
		--sand-fill-primary: #070707;
		--sand-fill-primary-hover: #2f2f2f;
		--sand-radius: 6px;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 20px;
		background: var(--sand-bg-base);
		color: var(--sand-text-primary);
		font-family: Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
		font-size: 13px;
		line-height: 1.45;
		-webkit-font-smoothing: antialiased;
		user-select: none;
	}
	h1 { font-size: 14px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
	.origin {
		font-weight: 600;
		word-break: break-all;
		padding: 8px 10px;
		border: 1px solid var(--sand-border-default);
		border-radius: var(--sand-radius);
		background: var(--sand-bg-subtle);
	}
	p { color: var(--sand-text-secondary); margin: 10px 0 16px; }
	input {
		width: 100%;
		padding: 8px 10px;
		font: inherit;
		color: var(--sand-text-primary);
		background: var(--sand-bg-base);
		border: 1px solid var(--sand-border-default);
		border-radius: var(--sand-radius);
		user-select: text;
	}
	input:focus { outline: none; border-color: var(--sand-border-strong); }
	.row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
	button {
		padding: 7px 14px;
		font: inherit;
		font-weight: 500;
		border-radius: var(--sand-radius);
		border: 1px solid var(--sand-border-default);
		background: var(--sand-bg-base);
		color: var(--sand-text-primary);
	}
	button:hover { background: var(--sand-bg-subtle); }
	button.primary {
		background: var(--sand-fill-primary);
		border-color: var(--sand-fill-primary);
		color: var(--sand-text-on-primary);
	}
	.spinner {
		width: 18px; height: 18px; margin-top: 4px;
		border: 2px solid var(--sand-border-default);
		border-top-color: var(--sand-text-primary);
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	button.primary:hover {
		background: var(--sand-fill-primary-hover);
		border-color: var(--sand-fill-primary-hover);
	}
</style>
<div id="prompt">
	<h1>Use your security key?</h1>
	<div class="origin" id="origin"></div>
	<p id="detail"></p>
	<div class="row">
		<button id="deny">Deny</button>
		<button id="allow" class="primary">Approve</button>
	</div>
</div>
<div id="working" hidden>
	<h1>Waiting for your security key</h1>
	<div class="origin" id="origin-working"></div>
	<p id="status"></p>
	<div class="spinner"></div>
</div>
<div id="pin-prompt" hidden>
	<h1>Enter your security key PIN</h1>
	<div class="origin" id="origin-pin"></div>
	<p id="pin-detail"></p>
	<input id="pin" type="password" />
	<div class="row">
		<button id="pin-cancel">Cancel</button>
		<button id="pin-submit" class="primary">Continue</button>
	</div>
</div>
<script>
	const origin = ${safeOrigin};
	const rpId = ${safeRpId};
	for (const id of ["origin", "origin-working", "origin-pin"]) {
		document.getElementById(id).textContent = origin;
	}
	document.getElementById("detail").textContent =
		"A browser in your Grok Bot box is asking to sign in to " + rpId +
		" with the security key plugged into this computer. Approve only if you started this.";

	const panels = ["prompt", "working", "pin-prompt"];
	function show(name) {
		for (const panel of panels) {
			document.getElementById(panel).hidden = panel !== name;
		}
	}
	// Approving switches to a working state rather than closing: the key can take
	// seconds to reach its touch prompt, and a vanished window reads as a hang.
	// The coordinator drives the text from there via window.__sandStatus.
	let answerPin;
	function working(text) {
		document.getElementById("status").textContent = text;
		// An outstanding PIN prompt owns the window: progress text that stole it
		// would leave the user no field to answer, and the ceremony would stall.
		if (answerPin === undefined) show("working");
	}
	window.__sandStatus = working;

	window.__sandRequestPin = request => {
		const field = document.getElementById("pin");
		field.value = "";
		document.getElementById("pin-detail").textContent = request.invalid
			? "That PIN was not accepted." + (request.retries == null
				? " Try again."
				: " " + request.retries + " attempts left before the key locks itself.")
			: "Your security key is protected by a PIN. Enter it to sign in to " + rpId + ".";
		show("pin-prompt");
		field.focus();
		return new Promise(resolve => { answerPin = resolve; });
	};
	function settlePin(answer, status) {
		const resolve = answerPin;
		answerPin = undefined;
		working(status);
		resolve?.(answer);
	}
	function submitPin() {
		const pin = document.getElementById("pin").value;
		// Sending "" spends one of the key's few attempts on nothing.
		if (pin === "") return;
		settlePin({ pin }, "Checking your PIN\u2026");
	}
	function cancelPin() {
		settlePin({ pin: null }, "Cancelling\u2026");
	}
	document.getElementById("pin-submit").onclick = submitPin;
	document.getElementById("pin-cancel").onclick = cancelPin;

	const answer = new Promise(resolve => {
		document.getElementById("allow").onclick = () => {
			working("Waking your security key\u2026");
			resolve({ approved: true });
		};
		document.getElementById("deny").onclick = () => resolve({ approved: false });
		document.addEventListener("keydown", event => {
			const pinning = !document.getElementById("pin-prompt").hidden;
			if (event.key === "Enter") {
				if (pinning) submitPin();
				else document.getElementById("allow").click();
			}
			if (event.key === "Escape") {
				if (pinning) cancelPin();
				else resolve({ approved: false });
			}
		});
	});
	window.__sandConsent = answer;
</script>`;
}

export function createWebAuthnPromptController(
  dependencies: WebAuthnPromptDependencies,
): WebAuthnPromptController {
  let openPrompt: WebAuthnPromptWindow | undefined;
  let openPromptId: string | undefined;
  const mintPromptId = dependencies.randomUUID ?? randomUUID;
  const platform = dependencies.platform ?? process.platform;

  const finish = (): void => {
    if (openPrompt !== undefined && !openPrompt.isDestroyed()) openPrompt.destroy();
    openPrompt = undefined;
    openPromptId = undefined;
  };

  return {
    update(status) {
      if (openPrompt === undefined || openPrompt.isDestroyed()) return;
      void openPrompt.webContents
        .executeJavaScript(
          `window.__sandStatus?.(${JSON.stringify(status)})`,
          true,
        )
        .catch(finish);
    },
    async requestPin(request) {
      if (openPrompt === undefined || openPrompt.isDestroyed()) return { pin: null };
      if (request.promptId !== openPromptId) return { pin: null };
      const answer = (await openPrompt.webContents
        .executeJavaScript(
          `window.__sandRequestPin?.(${JSON.stringify(request)})`,
          true,
        )
        .catch(() => ({ pin: null }))) as { readonly pin?: string | null } | null;
      return { pin: answer?.pin ?? null };
    },
    finish,
    async requestConsent(args) {
      finish();
      const promptId = mintPromptId();
      const window = dependencies.createWindow(PROMPT_WINDOW_OPTIONS);
      try {
        await window.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(renderPrompt(args.origin, args.rpId))}`,
        );
        const dismissed = new Promise<{ readonly approved: false }>((resolve) => {
          window.once("closed", () => resolve({ approved: false }));
        });
        const answered = window.webContents.executeJavaScript(
          "window.__sandConsent",
          true,
        ) as Promise<{ readonly approved: boolean }>;
        openPrompt = window;
        openPromptId = promptId;
        const answer = await Promise.race([answered, dismissed]);
        if (!answer.approved) {
          finish();
          return { approved: false, promptId: null };
        }
        return {
          approved: true,
          promptId,
          windowHandle: windowsDialogParentHandle(window, platform),
        };
      } catch (error) {
        if (!window.isDestroyed()) window.destroy();
        if (openPrompt === window) {
          openPrompt = undefined;
          openPromptId = undefined;
        }
        throw error;
      }
    },
  };
}

/** Restores the main-process command surface consumed by the coordinator. */
export function createCoordinatorControlExecutors(
  dependencies: CoordinatorControlExecutorDependencies,
) {
  const { connector, webauthnPrompt } = dependencies;
  const native = dependencies.native ?? {
    spawnLocalExecDaemon,
    terminateProcess,
    isProcessAlive,
    readProcessIdentity,
    resolveLocalExecDaemonEntryRealpath,
  };
  const daemonExitSettlements = new Map<string, Promise<{ readonly identity: LocalExecProcessIdentity; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>>();
  const ownedDaemonIdentities = new Map<number, LocalExecProcessIdentity>();
  const identityKey = (identity: LocalExecProcessIdentity) => `${identity.pid}:${identity.startEpochMs}:${identity.command}:${identity.entryRealpath}:${identity.generationToken}`;
  const expectedMatches = (expected: ExpectedLocalExecProcessIdentity, identity: LocalExecProcessIdentity): boolean => expected.pid === identity.pid
    && expected.entryRealpath === identity.entryRealpath
    && expected.generationToken === identity.generationToken
    && (expected.startEpochMs === undefined || expected.startEpochMs === identity.startEpochMs)
    && (expected.command === undefined || expected.command === identity.command)
    && (expected.discoveryStartedAt === undefined || localExecDiscoveryTimeMatchesProcess(expected.discoveryStartedAt, identity.startEpochMs, Date.now()));
  const readOwnedIdentity = (expected: ExpectedLocalExecProcessIdentity): LocalExecProcessIdentity | null => {
    const registered = ownedDaemonIdentities.get(expected.pid);
    if (registered != null && !expectedMatches(expected, registered)) return null;
    if (registered == null) {
      let canonicalEntryRealpath: string;
      try { canonicalEntryRealpath = (native.resolveLocalExecDaemonEntryRealpath ?? resolveLocalExecDaemonEntryRealpath)(); }
      catch { return null; }
      if (expected.entryRealpath !== canonicalEntryRealpath) return null;
      const observed = native.readProcessIdentity(expected.pid);
      if (observed == null || !commandCarriesLocalExecGeneration(observed.command, canonicalEntryRealpath, expected.generationToken)) return null;
      const adopted: LocalExecProcessIdentity = { ...observed, entryRealpath: canonicalEntryRealpath, generationToken: expected.generationToken };
      if (!expectedMatches(expected, adopted)) return null;
      ownedDaemonIdentities.set(adopted.pid, adopted);
      return adopted;
    }
    const observed = native.readProcessIdentity(expected.pid);
    if (observed == null || observed.startEpochMs !== registered.startEpochMs || observed.command !== registered.command) return null;
    if (!commandCarriesLocalExecGeneration(observed.command, registered.entryRealpath, registered.generationToken)) return null;
    return registered;
  };
  const stopUnidentifiedSpawn = async (child: Awaited<ReturnType<typeof native.spawnLocalExecDaemon>>["child"]): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(forceTimer); clearTimeout(giveUpTimer); resolve(); };
      child.once("exit", finish);
      const forceTimer = setTimeout(() => { if (!settled && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2_000);
      const giveUpTimer = setTimeout(() => { if (settled) return; settled = true; clearTimeout(forceTimer); reject(new Error(`local-exec child ${child.pid ?? "unknown"} did not exit after owned-handle termination`)); }, 4_000);
      child.kill("SIGTERM");
    });
  };

  return {
    resolveGatewayConnection: async (args?: { readonly purpose?: string }) => {
      const connection = await connector.connect();
      // Only the descriptor the local-exec daemon reads may carry the
      // per-machine token; the gateway transport shares this same call and
      // must keep speaking as the gateway.
      if (args?.purpose !== "local-exec-daemon" || dependencies.readOpenGrokDaemonIdentity == null) return connection;
      try {
        return withOpenGrokDaemonToken(connection, await dependencies.readOpenGrokDaemonIdentity());
      } catch {
        return connection;
      }
    },
    listRoutedMcpTools: async () => {
      if (dependencies.listRoutedMcpTools == null) throw new Error("Desktop MCP routing is unavailable.");
      return await dependencies.listRoutedMcpTools();
    },
    executeRoutedMcpTool: async (request: unknown) => {
      if (dependencies.executeRoutedMcpTool == null) throw new Error("Desktop MCP routing is unavailable.");
      return await dependencies.executeRoutedMcpTool(request);
    },
    runMessagesOp: async (op: unknown) => {
      if (dependencies.runMessagesOp == null) throw new Error("Messages are only available on macOS.");
      return await dependencies.runMessagesOp(op);
    },
    async mintLocalExecDaemonCredential() {
      return (await connector.issueLocalExecDaemonCredential?.()) ?? null;
    },
    requestWebAuthnConsent: (args: WebAuthnConsentRequest) =>
      webauthnPrompt.requestConsent(args),
    requestWebAuthnPin: (args: WebAuthnPinRequest) => webauthnPrompt.requestPin(args),
    updateWebAuthnConsent: ({ status }: { readonly status: string }) =>
      webauthnPrompt.update(status),
    finishWebAuthnConsent: () => webauthnPrompt.finish(),
    async spawnLocalExecDaemon(args: {
      readonly logPath: string;
      readonly env: NodeJS.ProcessEnv;
    }) {
      // The SAND_ASKPASS_* trio lets `sudo -A` in the daemon's shells reach the
      // app's password card; empty (and a no-op) on Windows and in tests.
      const spawned = await native.spawnLocalExecDaemon({ ...args, env: { ...args.env, ...askpassDaemonEnvironment() } });
      const { child, entryRealpath, generationToken } = spawned;
      if (child.pid === undefined) throw new Error("local-exec daemon spawn returned no pid");
      try {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const observed = native.readProcessIdentity(child.pid);
          if (observed != null && commandCarriesLocalExecGeneration(observed.command, entryRealpath, generationToken)) {
            const identity: LocalExecProcessIdentity = { ...observed, entryRealpath, generationToken };
            ownedDaemonIdentities.set(identity.pid, identity);
            const exit = new Promise<{ readonly identity: typeof identity; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) { resolve({ identity, exitCode: child.exitCode, signal: child.signalCode }); return; }
              child.once("exit", (exitCode, signal) => resolve({ identity, exitCode, signal }));
            }).finally(() => { if (ownedDaemonIdentities.get(identity.pid) === identity) ownedDaemonIdentities.delete(identity.pid); });
            daemonExitSettlements.set(identityKey(identity), exit);
            return identity;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`local-exec daemon ${child.pid} did not expose a verifiable process identity`);
      } catch (error) {
        await stopUnidentifiedSpawn(child);
        const discovery = await (dependencies.readLocalExecDaemonDiscovery ?? (() => readLocalExecDaemonDiscovery(getLocalExecDaemonDiscoveryPath())))();
        if (discovery != null
          && discovery.pid === child.pid
          && discovery.entryRealpath === entryRealpath
          && discovery.generationToken === generationToken) {
          await (dependencies.clearLocalExecDaemonDiscoveryIfMatches ?? ((expected) => clearLocalExecDaemonDiscoveryIfMatches(expected, getLocalExecDaemonDiscoveryPath())))(discovery);
        }
        throw error;
      }
    },
    async terminateProcess({ identity }: { readonly identity: LocalExecProcessIdentity }) {
      const observed = readOwnedIdentity(identity);
      if (observed == null || !sameLocalExecProcessIdentity(observed, identity)) return { terminated: false };
      await native.terminateProcess(identity.pid);
      return { terminated: true };
    },
    isProcessAlive: ({ pid }: { readonly pid: number }) => native.isProcessAlive(pid),
    getProcessIdentity: (expected: ExpectedLocalExecProcessIdentity) => readOwnedIdentity(expected),
    async waitLocalExecDaemonExit(identity: LocalExecProcessIdentity) {
      const key = identityKey(identity);
      const settlement = daemonExitSettlements.get(key);
      if (settlement === undefined) throw new Error("local-exec daemon exit identity is not registered");
      try { return await settlement; }
      finally { if (daemonExitSettlements.get(key) === settlement) daemonExitSettlements.delete(key); }
    },
    getRpcTraceWindowTraceparent: () =>
      dependencies.getRpcTraceWindowTraceparent?.() ?? null,
    reportTransportStage(report: CoordinatorTransportStageReport) {
      // The local log takes every stage, sampled or not: the echo of a send and its absence are
      // the evidence for "the stream was up / was dead" and must not depend on trace sampling.
      getLocalTelemetryLog()?.append(report.isError ? "warn" : "info", "sand.send_stage", { stage: report.stage, attempt: report.attempt, client_nonce: report.clientNonce, duration_ms: Math.round(report.durationMs), is_error: report.isError, traceparent: report.traceparent ?? undefined });
      if (report.traceparent == null) return;
      dependencies.recordSendStage({
        name: report.stage,
        traceparent: report.traceparent,
        clientNonce: report.clientNonce,
        startEpochMs: report.startEpochMs,
        durationMs: report.durationMs,
        attributes: { "sand.attempt": report.attempt },
        isError: report.isError,
      });
    },
    reportGatewayCommandSpan(report: unknown) {
      const span = (typeof report === "object" && report != null ? report : {}) as Record<string, unknown>;
      getLocalTelemetryLog()?.append(span.isError === true ? "warn" : "info", "sand.gateway_command", { method: span.method, request_id: span.requestId, duration_ms: typeof span.durationMs === "number" ? Math.round(span.durationMs) : undefined, is_error: span.isError === true });
      dependencies.recordGatewayCommandSpan(report);
    },
    reportGatewayReachability(report: unknown) {
      dependencies.onReachability(report);
    },
    reportGatewayDnsDiagnostic(report: unknown) {
      dependencies.onDnsDiagnostic(report);
    },
    reportProcessCrash(report: unknown) {
      dependencies.onProcessCrash(report);
    },
  };
}
