import { DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES, localExecFileTooLargeMessage } from "../shared/local-exec-gateway.js";
import type { JsonValue } from "@bufbuild/protobuf";
import {
  buildLocalExecManager,
  resolveLocalExecRoot,
  type LocalExecManagerRuntime,
} from "../host/local-exec/local-exec-machine.js";
import type {
  LocalExecDecodedMessage,
  LocalExecExecutor,
  LocalExecExecutorOutput,
} from "../host/local-exec/local-exec-provider.js";
import { backgroundShellExecutorResource } from "../packages/agent-exec/background-shell.js";
import { askpassShellEnv } from "./askpass-shell-env.js";
import { SimpleControlledExecManager } from "../packages/agent-exec/controlled.js";
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientThrow,
  ExecServerMessage,
} from "../packages/proto/generated/agent/v1/exec_pb.js";
import {
  ExecServerAbort,
  ExecServerControlMessage,
} from "../packages/proto/generated/agent/v1/agent_service_pb.js";
import { lsExecutorResource } from "../packages/agent-exec/ls.js";
import { readExecutorResource } from "../packages/agent-exec/read.js";
import { RegistryResourceAccessor } from "../packages/agent-exec/resource-provider.js";
import { shellStreamExecutorResource } from "../packages/agent-exec/shell-stream.js";
import { createContext, type Context } from "../packages/context/core.js";
import { LocalBackgroundShellExecutor } from "../packages/local-exec/background-shell.js";
import { LocalLsExecutor } from "../packages/local-exec/ls.js";
import { LocalReadExecutor } from "../packages/local-exec/read.js";
import { BaseShellCoreExecutor } from "../packages/local-exec/shell-core.js";
import { LocalShellStreamExecutor } from "../packages/local-exec/shell-stream.js";
import { MockIgnoreService, MockPermissionsService } from "../packages/local-exec/tests/common.js";
import { ReadError, ReadResult } from "../packages/proto/generated/agent/v1/read_exec_pb.js";
import { ShellStream, ShellStreamStderr } from "../packages/proto/generated/agent/v1/shell_exec_pb.js";
import type { SandboxPolicy as ProtoSandboxPolicy } from "../packages/proto/generated/agent/v1/sandbox_pb.js";
import { createDefaultTerminalExecutor } from "../packages/shell-exec/index.js";

export type ProductionLocalExecExecutorFactory = () => LocalExecExecutor;

interface ShellResourceArgs {
  command: string;
  workingDirectory?: string;
  toolCallId?: string;
  conversationId?: string;
  requestedSandboxPolicy?: ProtoSandboxPolicy;
  closeStdin?: boolean;
}

interface PathResourceArgs {
  path: string;
  toolCallId?: string;
  offset?: number;
  limit?: number;
  encodingHint?: string;
  ignore?: readonly string[];
  timeoutMs?: number;
  sandboxPolicy?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireShellResourceArgs(value: unknown): asserts value is ShellResourceArgs {
  if (!isRecord(value) || typeof value.command !== "string") {
    throw new TypeError("local-exec shell resource arguments require a string command");
  }
  if (value.workingDirectory !== undefined && typeof value.workingDirectory !== "string") {
    throw new TypeError("local-exec shell workingDirectory must be a string");
  }
}

function requirePathResourceArgs(value: unknown): asserts value is PathResourceArgs {
  if (!isRecord(value) || typeof value.path !== "string") {
    throw new TypeError("local-exec path resource arguments require a string path");
  }
}

export const PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS = Object.freeze([
  "managerRuntime.build",
  "codec.decodeServerMessage",
  "codec.toManagerMessage",
  "codec.isClientMessage",
  "codec.clientMessageToJson",
  "codec.controlMessageToJson",
  "codec.createAbortControl",
  "codec.createThrowControl",
  "createContext",
] as const);

export class ProductionLocalExecCompositionError extends Error {
  constructor(readonly missingBindings: readonly string[]) {
    super(`local-exec production runtime is missing mandatory bindings: ${missingBindings.join(", ")}`);
    this.name = "ProductionLocalExecCompositionError";
  }
}

/**
 * The shipped daemon binds the generated ExecServerMessage, ExecClientMessage,
 * and ExecClientControlMessage classes at this boundary. Keeping every codec
 * operation mandatory prevents JSON-shaped substitutes from being presented as
 * the production protobuf transport.
 */
export interface ProductionExecCodec<
  ServerMessage,
  ClientMessage,
  ClientControlMessage,
  ServerControlMessage,
> {
  decodeServerMessage(json: JsonValue): LocalExecDecodedMessage;
  toManagerMessage(message: LocalExecDecodedMessage): ServerMessage;
  isClientMessage(message: ClientMessage | ClientControlMessage): message is ClientMessage;
  clientMessageToJson(message: ClientMessage): JsonValue;
  controlMessageToJson(message: ClientControlMessage): JsonValue;
  createAbortControl(execId: number): ServerControlMessage;
  createThrowControl(execId: number, error: string): ClientControlMessage;
}

/** The exact surface used from the shipped SimpleControlledExecManager. */
export interface ProductionControlledExecManager<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage> {
  handle(context: Context, message: ServerMessage): AsyncIterable<ClientMessage | ClientControlMessage>;
  handleControlMessage(message: ServerControlMessage): void;
}

export interface ProductionLocalExecRuntime<
  Context,
  ServerMessage,
  ClientMessage,
  ClientControlMessage,
  ServerControlMessage,
  Manager extends ProductionControlledExecManager<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage>,
> {
  /**
   * This builder must register the shipped shell-stream, background-shell,
   * read, and list resources and return SimpleControlledExecManager.
   */
  readonly managerRuntime: LocalExecManagerRuntime<Manager>;
  readonly codec: ProductionExecCodec<ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage>;
  /**
   * Supplies the cancellable package Context used by the controlled manager.
   * The shipped no-op loggerKey binding has no recovered public key export;
   * the clean controlled manager owns its evidenced logger directly.
   */
  readonly createContext: (signal: AbortSignal) => Context;
}

export interface ProductionLocalExecExecutorOptions<
  Context,
  ServerMessage,
  ClientMessage,
  ClientControlMessage,
  ServerControlMessage,
  Manager extends ProductionControlledExecManager<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage>,
> {
  readonly runtime: ProductionLocalExecRuntime<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage, Manager>;
  readonly root?: string;
  readonly maxFileBytes?: number;
}

function requiredFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

export function assertProductionLocalExecRuntime(runtime: unknown): void {
  const value = runtime as {
    managerRuntime?: { build?: unknown };
    codec?: Record<string, unknown>;
    createContext?: unknown;
  } | null;
  const missing: string[] = [];
  if (!requiredFunction(value?.managerRuntime?.build)) missing.push("managerRuntime.build");
  for (const binding of PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS.slice(1, -1)) {
    const method = binding.slice("codec.".length);
    if (!requiredFunction(value?.codec?.[method])) missing.push(binding);
  }
  if (!requiredFunction(value?.createContext)) missing.push("createContext");
  if (missing.length > 0) throw new ProductionLocalExecCompositionError(missing);
}

/**
 * Adapts the shipped generated codec and controlled-manager graph to the
 * recovered gateway provider. There are deliberately no codec or executor
 * fallbacks: production construction is impossible until both mandatory ports
 * are supplied by recovered package source.
 */
export function createProductionLocalExecExecutor<
  Context,
  ServerMessage,
  ClientMessage,
  ClientControlMessage,
  ServerControlMessage,
  Manager extends ProductionControlledExecManager<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage>,
>(options: ProductionLocalExecExecutorOptions<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage, Manager>): LocalExecExecutor {
  assertProductionLocalExecRuntime(options.runtime);
  const root = options.root ?? resolveLocalExecRoot();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES;
  const manager = buildLocalExecManager(root, maxFileBytes, options.runtime.managerRuntime);
  const { codec } = options.runtime;

  return {
    decodeServerMessage: (json): LocalExecDecodedMessage => codec.decodeServerMessage(json),
    execute: async function* (message: LocalExecDecodedMessage, signal: AbortSignal): AsyncIterable<LocalExecExecutorOutput> {
      const context = options.runtime.createContext(signal);
      for await (const output of manager.handle(context, codec.toManagerMessage(message))) {
        if (codec.isClientMessage(output)) {
          yield { kind: "client", message: codec.clientMessageToJson(output) };
        } else {
          yield { kind: "control", message: codec.controlMessageToJson(output) };
        }
      }
    },
    cancel: (execId): void => manager.handleControlMessage(codec.createAbortControl(execId)),
    throwControl: (error): JsonValue => codec.controlMessageToJson(codec.createThrowControl(0, error)),
  };
}

function contextFromSignal(signal: AbortSignal): Context {
  const [context, cancel] = createContext().withCancel();
  if (signal.aborted) cancel(signal.reason);
  else signal.addEventListener("abort", () => cancel(signal.reason), { once: true });
  return context;
}

class GatewayExecServerMessage implements LocalExecDecodedMessage {
  constructor(readonly generated: ExecServerMessage) {}

  get id(): number { return this.generated.id; }
  set id(value: number) { this.generated.id = value; }

  get message(): { readonly case?: string; readonly value?: Record<string, unknown> } {
    const { case: messageCase, value } = this.generated.message;
    if (messageCase === undefined) return {};
    if (!isRecord(value)) return { case: messageCase };
    return { case: messageCase, value };
  }
}

/**
 * Exact first-party resource graph emitted by local-exec-machine.ts. Stateful
 * terminal creation remains lazy inside createDefaultTerminalExecutor, so
 * construction and non-shell resources do not pretend that a missing native
 * shell binding exists.
 */
export function createDefaultProductionLocalExecExecutor(options: {
  readonly root?: string;
  readonly maxFileBytes?: number;
} = {}): LocalExecExecutor {
  const managerRuntime: LocalExecManagerRuntime<SimpleControlledExecManager> = {
    build(root, maxFileBytes, guards) {
      const permissionsService = new MockPermissionsService();
      const ignoreService = new MockIgnoreService();
      const terminalExecutor = createDefaultTerminalExecutor({
        env: { CURSOR_AGENT: "1", SAND_AGENT: "1" },
      }).clone(root);
      const shellCoreExecutor = new BaseShellCoreExecutor(terminalExecutor, root, root, undefined, () => askpassShellEnv());
      const backgroundShellExecutor = new LocalBackgroundShellExecutor(
        permissionsService,
        shellCoreExecutor,
        ignoreService,
        root,
        undefined,
        undefined,
      );
      const shellStreamExecutor = new LocalShellStreamExecutor(
        permissionsService,
        shellCoreExecutor,
        ignoreService,
        backgroundShellExecutor.getManager(),
      );
      const readExecutor = new LocalReadExecutor(permissionsService, root);
      const lsExecutor = new LocalLsExecutor(permissionsService, ignoreService, root);
      const registry = new RegistryResourceAccessor();

      registry.register(shellStreamExecutorResource, {
        execute: (ctx: Context, argsValue: unknown) => (async function* () {
          requireShellResourceArgs(argsValue);
          const args = argsValue;
          const requested = args.workingDirectory ?? "";
          const resolution = await guards.resolveShellWorkingDirectory({ root, requested });
          args.workingDirectory = resolution.workingDirectory;
          if (resolution.fellBackToRoot) {
            yield new ShellStream({
              event: {
                case: "stderr",
                value: new ShellStreamStderr({ data: guards.missingWorkingDirectoryNotice({ requested, root }) }),
              },
            });
          }
          yield* shellStreamExecutor.execute(ctx, args);
        })(),
      });
      registry.register(backgroundShellExecutorResource, {
        execute: async (ctx: Context, argsValue: unknown) => {
          requireShellResourceArgs(argsValue);
          const args = argsValue;
          const resolution = await guards.resolveShellWorkingDirectory({ root, requested: args.workingDirectory ?? "" });
          args.workingDirectory = resolution.workingDirectory;
          return backgroundShellExecutor.execute(ctx, args);
        },
      });
      registry.register(readExecutorResource, {
        execute: async (ctx: Context, argsValue: unknown) => {
          requirePathResourceArgs(argsValue);
          const args = argsValue;
          const resolved = await guards.containPath({ root, path: args.path });
          const sizeBytes = await guards.regularFileSizeBytes(resolved);
          if (sizeBytes !== undefined && sizeBytes > maxFileBytes) {
            return new ReadResult({
              result: {
                case: "error",
                value: new ReadError({ path: resolved, error: localExecFileTooLargeMessage(sizeBytes, maxFileBytes) }),
              },
            });
          }
          return readExecutor.execute(ctx, args);
        },
      });
      registry.register(lsExecutorResource, {
        execute: async (ctx: Context, argsValue: unknown) => {
          requirePathResourceArgs(argsValue);
          const args = argsValue;
          await guards.containPath({ root, path: args.path });
          return lsExecutor.execute(ctx, args);
        },
      });
      return SimpleControlledExecManager.fromResources(registry);
    },
  };

  return createProductionLocalExecExecutor<
    Context,
    ExecServerMessage,
    ExecClientMessage,
    ExecClientControlMessage,
    ExecServerControlMessage,
    SimpleControlledExecManager
  >({
    runtime: {
      managerRuntime,
      codec: {
        decodeServerMessage: (json) => new GatewayExecServerMessage(ExecServerMessage.fromJson(json, { ignoreUnknownFields: true })),
        toManagerMessage: (message) => {
          if (!(message instanceof GatewayExecServerMessage)) {
            throw new TypeError("local-exec decoded message did not originate from the generated production codec");
          }
          return message.generated;
        },
        isClientMessage: (message): message is ExecClientMessage => message instanceof ExecClientMessage,
        clientMessageToJson: (message) => message.toJson(),
        controlMessageToJson: (message) => message.toJson(),
        createAbortControl: (execId) => new ExecServerControlMessage({
          message: { case: "abort", value: new ExecServerAbort({ id: execId }) },
        }),
        createThrowControl: (execId, error) => new ExecClientControlMessage({
          message: { case: "throw", value: new ExecClientThrow({ id: execId, error }) },
        }),
      },
      createContext: contextFromSignal,
    },
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
  });
}
