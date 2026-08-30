import { DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES, SAND_NO_LOCAL_MACHINE_MESSAGE, localExecFileTooLargeMessage } from "../../../shared/local-exec-gateway.js";
import { SAND_LOCAL_TOOLS_UNDESCRIBABLE_MESSAGE, SandLocalToolPermissionDeniedError, authorizeLocalToolAction, describeLocalExec, sandLocalToolScopeKey, type LocalExecMessage, type SandLocalToolGate, type SandLocalToolScope } from "../../../shared/local-tool-permission-machinery.js";
import { describeMessagesOp, type MessagesOp } from "../../../shared/messages-request.js";
import type { Context } from "../../../packages/context/core.js";
import { classifyLocalExecFailure, type LocalExecFailureClassification } from "./local-exec-failure-classifier.js";
import { SandLocalExecError } from "./local-exec-error.js";
import { SandLocalExecBridge } from "./local-exec-bridge.js";

export const FALLBACK_TERMINALS_FOLDER = "terminals";

export type SandBoxContext = Context;
export interface GatewayExecServerMessage { readonly message?: { readonly case?: string; readonly value?: Record<string, unknown> }; toJson(): unknown; }
export type GatewayExecControl =
  | { readonly case: "throw"; readonly error: string; readonly stackTrace?: string }
  | { readonly case: "streamClose" }
  | { readonly case: undefined };
export interface GatewayLocalExecCodec<Client = unknown, Accessor = unknown> {
  decodeClient(json: unknown): Client;
  decodeControl(json: unknown): GatewayExecControl;
  createRemoteAccessor(manager: GatewayLocalExecManager<Client>): Accessor;
}
export interface LocalExecFailureReport extends LocalExecFailureClassification { readonly site: "exec"; readonly conversationId?: string; }
export interface GatewayLocalToolGate extends SandLocalToolGate { blockedReason(): string | undefined; requiresApproval(): boolean; }

function normalizeDescribableMessage(
  decoded: GatewayExecServerMessage
): { readonly message: LocalExecMessage } | undefined {
  const message = decoded.message;
  if (
    typeof message?.case !== "string" ||
    message.value == null ||
    typeof message.value !== "object" ||
    Array.isArray(message.value)
  ) return undefined;
  return { message: { case: message.case, value: message.value } };
}

export class GatewayLocalExecManager<Client = unknown> {
  private nextId = 0;
  constructor(private readonly bridge: SandLocalExecBridge, private readonly gate: GatewayLocalToolGate, private readonly getTerminalsFolder: () => string, private readonly codec: GatewayLocalExecCodec<Client>, private readonly reportFailure?: (report: LocalExecFailureReport) => void) {}
  async *createExecInstance(context: SandBoxContext, argsSerializer: (id: number) => GatewayExecServerMessage): AsyncGenerator<Client> {
    const serverMessage = argsSerializer(this.nextId++); const normalized = normalizeDescribableMessage(serverMessage); const described = normalized === undefined ? undefined : describeLocalExec(normalized, this.getTerminalsFolder()); const scope = context.get(sandLocalToolScopeKey); const blocked = this.gate.blockedReason();
    if (blocked !== undefined) throw new SandLocalToolPermissionDeniedError(blocked); if (described === undefined && this.gate.requiresApproval()) throw new SandLocalToolPermissionDeniedError(SAND_LOCAL_TOOLS_UNDESCRIBABLE_MESSAGE);
    this.bridge.assertComputerAvailable(undefined, { site: "exec", ...(scope?.agentId === undefined ? {} : { agentId: scope.agentId }) });
    const approvalId = described === undefined ? undefined : await authorizeLocalToolAction(this.gate, scope, { ...described, signal: context.signal });
    const frames = this.bridge.request({ signal: context.signal, ...(scope?.agentId === undefined ? {} : { agentId: scope.agentId }) }, { kind: "exec", serverMessage: serverMessage.toJson(), ...(approvalId === undefined ? {} : { approvalId }) }, undefined, { watchResponse: true });
    for await (const frame of frames) {
      if (frame.kind === "client") { yield this.codec.decodeClient(frame.message); continue; }
      if (frame.kind !== "control") continue; const control = this.codec.decodeControl(frame.message);
      if (control.case === "throw") { const message = control.error; this.reportFailure?.({ ...classifyLocalExecFailure(message), site: "exec", ...(scope?.agentId === undefined ? {} : { conversationId: scope.agentId }) }); const error = new Error(message); if (control.stackTrace != null && control.stackTrace.length > 0) error.stack = control.stackTrace; throw error; }
      if (control.case === "streamClose") return;
    }
  }
}

export interface GatewayLocalExecSandBoxOptions<Client = unknown, Accessor = GatewayLocalExecManager<Client>> {
  readonly gate: GatewayLocalToolGate; readonly codec: GatewayLocalExecCodec<Client, Accessor>; readonly computerId?: string; readonly maxFileBytes?: number;
  readonly reportFailure?: (report: LocalExecFailureReport) => void;
}

export class GatewayLocalExecSandBox<Client = unknown, Accessor = GatewayLocalExecManager<Client>> {
  private readonly gate: GatewayLocalToolGate; private readonly computerId: string | undefined; private readonly maxFileBytes: number;
  constructor(private readonly bridge: SandLocalExecBridge, private readonly options: GatewayLocalExecSandBoxOptions<Client, Accessor>) { this.gate = options.gate; this.computerId = options.computerId; this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES; }
  terminalsFolder(): string { return this.bridge.getProviderInfo()?.terminalsFolder ?? FALLBACK_TERMINALS_FOLDER; }
  async ensureReady(_context: SandBoxContext, _agentId: string): Promise<{ remoteAccessor: Accessor; vncUrl: ""; terminalsFolder: string }> { const manager = new GatewayLocalExecManager(this.bridge, this.gate, () => this.terminalsFolder(), this.options.codec, this.options.reportFailure); return { remoteAccessor: this.options.codec.createRemoteAccessor(manager), vncUrl: "", terminalsFolder: this.terminalsFolder() }; }
  async hibernate(_context: SandBoxContext, _agentId: string): Promise<void> {}
  async runState(_context: SandBoxContext, _agentId: string): Promise<"running" | "absent"> { return this.bridge.hasProvider() ? "running" : "absent"; }
  async listBoxes(): Promise<[]> { return []; }
  async uploadFile(context: SandBoxContext, _agentId: string, boxPath: string, data: Uint8Array): Promise<void> {
    if (data.length > this.maxFileBytes) throw new SandLocalExecError(localExecFileTooLargeMessage(data.length, this.maxFileBytes)); const blocked = this.gate.blockedReason(); if (blocked !== undefined) throw new SandLocalToolPermissionDeniedError(blocked);
    const scope = context.get(sandLocalToolScopeKey); this.bridge.assertComputerAvailable(this.computerId, { site: "upload", ...(scope?.agentId === undefined ? {} : { agentId: scope.agentId }) }); const approvalId = await authorizeLocalToolAction(this.gate, scope, { action: "write-file", target: boxPath, signal: context.signal });
    for await (const frame of this.bridge.request({ signal: context.signal, ...(scope?.agentId === undefined ? {} : { agentId: scope.agentId }) }, { kind: "upload", path: boxPath, bytesBase64: Buffer.from(data).toString("base64"), ...(approvalId === undefined ? {} : { approvalId }) }, this.computerId)) { if (frame.kind === "file") return; if (frame.kind === "file-error" && typeof frame.error === "string") throw new SandLocalExecError(frame.error); }
    throw new SandLocalExecError(SAND_NO_LOCAL_MACHINE_MESSAGE);
  }
  async downloadFile(context: SandBoxContext, _agentId: string, boxPath: string): Promise<Uint8Array> {
    const blocked = this.gate.blockedReason(); if (blocked !== undefined) throw new SandLocalToolPermissionDeniedError(blocked); const scope = context.get(sandLocalToolScopeKey); this.bridge.assertComputerAvailable(this.computerId, { site: "download", ...(scope?.agentId === undefined ? {} : { agentId: scope.agentId }) }); const approvalId = await authorizeLocalToolAction(this.gate, scope, { action: "read-file", target: boxPath, signal: context.signal });
    for await (const frame of this.bridge.request({ signal: context.signal, ...(scope?.agentId === undefined ? {} : { agentId: scope.agentId }) }, { kind: "download", path: boxPath, ...(approvalId === undefined ? {} : { approvalId }) }, this.computerId)) { if (frame.kind === "file" && typeof frame.bytesBase64 === "string") return new Uint8Array(Buffer.from(frame.bytesBase64, "base64")); if (frame.kind === "file-error" && typeof frame.error === "string") throw new SandLocalExecError(frame.error); }
    throw new SandLocalExecError(SAND_NO_LOCAL_MACHINE_MESSAGE);
  }
  /**
   * Messages lives on the user's Mac, not in the box, so the request is relayed
   * to the daemon over the same bridge the file transfers use. The op is
   * described before it is sent so the consent prompt names the conversation or
   * recipient it concerns, and the approval is per action — reading and sending
   * are asked for separately.
   */
  async messagesOp(context: SandBoxContext, op: MessagesOp): Promise<Record<string, unknown>> {
    const blocked = this.gate.blockedReason(); if (blocked !== undefined) throw new SandLocalToolPermissionDeniedError(blocked);
    const described = describeMessagesOp(op); if (described === undefined) throw new SandLocalExecError("Malformed Messages request.");
    const scope = context.get(sandLocalToolScopeKey); this.bridge.assertComputerAvailable(this.computerId, { site: "messages-op", ...(scope?.agentId === undefined ? {} : { agentId: scope.agentId }) });
    const approvalId = await authorizeLocalToolAction(this.gate, scope, { ...described, signal: context.signal });
    for await (const frame of this.bridge.request({ signal: context.signal, ...(scope?.agentId === undefined ? {} : { agentId: scope.agentId }) }, { kind: "messages-op", op: op as unknown as Record<string, unknown>, ...(approvalId === undefined ? {} : { approvalId }) }, this.computerId)) {
      if (frame.kind === "messages-result" && typeof frame.result === "object" && frame.result != null) return frame.result as Record<string, unknown>;
      if (frame.kind === "messages-error" && typeof frame.error === "string") throw new SandLocalExecError(frame.error);
    }
    throw new SandLocalExecError(SAND_NO_LOCAL_MACHINE_MESSAGE);
  }
}

export function createBridgeUserComputers<Client = unknown, Accessor = GatewayLocalExecManager<Client>>(bridge: SandLocalExecBridge, options: Omit<GatewayLocalExecSandBoxOptions<Client, Accessor>, "computerId">) {
  return {
    list: (): ReturnType<SandLocalExecBridge["listComputers"]> => bridge.listComputers(),
    resolve: (id?: string) => { const selected = id === undefined ? bridge.activeComputer() : bridge.listComputers().find((computer) => computer.id === id); return selected === undefined ? undefined : { id: selected.id, label: selected.label, box: new GatewayLocalExecSandBox(bridge, { ...options, ...(id === undefined ? {} : { computerId: selected.id }) }) }; }
  };
}
