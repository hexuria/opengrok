import { createIdleWatchdogPolicy, realClock } from "../../../internal/scheduling.js";
import { defineHostExtension } from "../../../internal/host-extensions.js";
import { SAND_LOCAL_EXEC_RESPONSE_TIMEOUT_MS } from "../../../shared/local-exec-gateway.js";
import { HostExtensions } from "../extension-ids.generated.js";
import type { GatewayLocalToolGate } from "./gateway-local-exec-sand-box.js";
import { GatewayLocalExecSandBox, createBridgeUserComputers, type GatewayLocalExecCodec } from "./gateway-local-exec-sand-box.js";
import { SandLocalExecBridge, type LocalExecBridgeFrame } from "./local-exec-bridge.js";

interface LocalExecLogs { reportLocalExecRefused(report: unknown): void; reportLocalExecProvider(report: unknown): void; reportLocalExecFailed(report: unknown): void; }
interface LocalExecHost { readonly events: { on(topic: string, listener: (payload: unknown) => void): () => void }; }

export function createLocalExecExtension<Client = unknown, Accessor = unknown>(codec: GatewayLocalExecCodec<Client, Accessor>) {
  return defineHostExtension<unknown, LocalExecHost>({
    id: HostExtensions.LocalExec, dependencies: [HostExtensions.LocalToolPermission, HostExtensions.Telemetry],
    start: (context) => {
      const gate = context.deps[HostExtensions.LocalToolPermission] as GatewayLocalToolGate; const logs = (context.deps[HostExtensions.Telemetry] as { readonly logs: LocalExecLogs }).logs;
      const bridge = new SandLocalExecBridge({ clock: realClock, responseWatchdog: createIdleWatchdogPolicy(realClock, { name: "sand-local-exec-response", idleMs: SAND_LOCAL_EXEC_RESPONSE_TIMEOUT_MS }), blockedReason: () => gate.blockedReason(), report: { refused: (report) => logs.reportLocalExecRefused(report), provider: (report) => logs.reportLocalExecProvider(report) } });
      const offRetirement = context.host.events.on("local-tool-permission.approval-retired", (payload) => { if (typeof payload === "object" && payload != null && typeof (payload as { approvalId?: unknown }).approvalId === "string") bridge.retireApproval((payload as { approvalId: string }).approvalId); }); context.onStop(offRetirement);
      const options = { gate, codec, reportFailure: (report: unknown) => logs.reportLocalExecFailed(report) };
      return { box: new GatewayLocalExecSandBox(bridge, options), userComputers: createBridgeUserComputers(bridge, options), registerProvider: (send: (frame: LocalExecBridgeFrame) => void) => bridge.registerProvider(send), submitResponses: (batch: Parameters<SandLocalExecBridge["submitResponses"]>[0]) => bridge.submitResponses(batch), checkLiveComputerForAsk: (agentId?: string) => bridge.checkLiveComputerForAsk(agentId) };
    }
  });
}
