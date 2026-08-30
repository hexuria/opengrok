import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { appendFile, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { MethodKind, type ServiceType } from "@bufbuild/protobuf";

import { ControlService } from "../packages/proto/generated/agent/v1/control_service_connect.js";
import { ExecService } from "../packages/proto/generated/agent/v1/exec_service_connect.js";
import {
  GetCapabilitiesResponse,
  LoadMcpServersResponse,
  PingResponse,
  UpdateEnvironmentVariablesResponse,
  type UpdateEnvironmentVariablesRequest,
} from "../packages/proto/generated/agent/v1/control_service_pb.js";
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientStreamClose,
  ExecClientThrow,
  type ExecServerMessage,
} from "../packages/proto/generated/agent/v1/exec_pb.js";
import { ExecStreamElement } from "../packages/proto/generated/agent/v1/exec_service_pb.js";
import {
  BackgroundShellSpawnError,
  BackgroundShellSpawnResult,
  BackgroundShellSpawnSuccess,
  WriteShellStdinError,
  WriteShellStdinResult,
  WriteShellStdinSuccess,
  type BackgroundShellSpawnArgs,
  type WriteShellStdinArgs,
} from "../packages/proto/generated/agent/v1/background_shell_exec_pb.js";
import {
  ReadError,
  ReadFileNotFound,
  ReadInvalidFile,
  ReadPermissionDenied,
  ReadRejected,
  ReadResult,
  ReadSuccess,
  type ReadArgs,
} from "../packages/proto/generated/agent/v1/read_exec_pb.js";
import {
  ShellFailure,
  ShellResult,
  ShellSpawnError,
  ShellStream,
  ShellStreamExit,
  ShellStreamStart,
  ShellStreamStderr,
  ShellStreamStdout,
  ShellSuccess,
  ShellTimeout,
  type ShellArgs,
} from "../packages/proto/generated/agent/v1/shell_exec_pb.js";

// Recovered generated descriptors predate `satisfies ServiceType` and therefore
// widen MethodKind during TypeScript reconstruction. Re-declaring only the
// daemon-owned routes preserves their exact names/message types and restores the
// literal method kinds required by Connect's implementation type inference.
const BoxControlService = {
  typeName: ControlService.typeName,
  methods: {
    ping: { ...ControlService.methods.ping, kind: MethodKind.Unary },
    getCapabilities: { ...ControlService.methods.getCapabilities, kind: MethodKind.Unary },
    updateEnvironmentVariables: { ...ControlService.methods.updateEnvironmentVariables, kind: MethodKind.Unary },
    loadMcpServers: { ...ControlService.methods.loadMcpServers, kind: MethodKind.Unary },
  },
} as const satisfies ServiceType;

const BoxExecService = {
  typeName: ExecService.typeName,
  methods: { exec: { ...ExecService.methods.exec, kind: MethodKind.ServerStreaming } },
} as const satisfies ServiceType;

export const BOX_EXEC_DAEMON_HOST = "127.0.0.1";
export const BOX_EXEC_DAEMON_PORT = 1337;
export const BOX_EXEC_DAEMON_AUTH_TOKEN = "local";
export const BOX_TERMINAL_VIRTUAL_PREFIX = "/root/.cursor/projects/workspace/terminals/";

export interface BoxExecDaemonOptions {
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly workspaceRoot: string;
  readonly terminalsDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface BoxExecDaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly workspaceRoot: string;
  readonly terminalsDirectory: string;
  readonly ready: Promise<void>;
  isReady(): boolean;
  stop(): Promise<void>;
}

interface BackgroundProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly terminalPath: string;
  readonly startedAt: number;
  writeQueue: Promise<void>;
}

interface ProcessOutcome {
  readonly code: number;
  readonly signal: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

class PathRejectedError extends Error {}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function terminalFrontmatter(args: BackgroundShellSpawnArgs, pid: number | undefined, startedAt: number): string {
  return `---\n${pid == null ? "" : `pid: ${pid}\n`}cwd: ${yamlString(args.workingDirectory)}\ncommand: ${yamlString(args.command)}\nstatus: running\nstarted_at: ${new Date(startedAt).toISOString()}\nrunning_for_ms: 0\n---\n`;
}

function terminalFooter(exitCode: number, startedAt: number): string {
  return `\n---\nexit_code: ${exitCode}\nelapsed_ms: ${Date.now() - startedAt}\nended_at: ${new Date().toISOString()}\n---\n`;
}

function client(id: number, execId: string, message: ExecClientMessage["message"], elapsedMs?: number): ExecStreamElement {
  return new ExecStreamElement({
    element: {
      case: "execClientMessage",
      value: new ExecClientMessage({ id, execId, message, ...(elapsedMs == null ? {} : { localExecutionTimeMs: elapsedMs }) }),
    },
  });
}

function control(id: number, message: ExecClientControlMessage["message"]): ExecStreamElement {
  return new ExecStreamElement({
    element: { case: "execClientControlMessage", value: new ExecClientControlMessage({ message }) },
  });
}

function close(id: number): ExecStreamElement {
  return control(id, { case: "streamClose", value: new ExecClientStreamClose({ id }) });
}

function thrown(id: number, error: unknown, errorCode = "BOX_EXEC_DAEMON_ERROR"): ExecStreamElement {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return control(id, {
    case: "throw",
    value: new ExecClientThrow({ id, error: normalized.message, ...(normalized.stack == null ? {} : { stackTrace: normalized.stack }), errorCode }),
  });
}

class BoxExecRuntime {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #foreground = new Set<ChildProcessWithoutNullStreams>();
  readonly #background = new Map<number, BackgroundProcess>();
  #nextShellId = 1;

  constructor(readonly workspaceRoot: string, readonly terminalsDirectory: string, environment: NodeJS.ProcessEnv) {
    this.#environment = { ...environment };
  }

  applyEnvironment(request: UpdateEnvironmentVariablesRequest): { applied: number; removed: number } {
    let removed = 0;
    if (request.replace) {
      for (const key of Object.keys(this.#environment)) {
        if (!(key in request.env)) {
          delete this.#environment[key];
          removed += 1;
        }
      }
    }
    for (const [key, value] of Object.entries(request.env)) this.#environment[key] = value;
    return { applied: Object.keys(request.env).length, removed };
  }

  resolvePath(requested: string): string {
    const logical = requested.length === 0 ? "/workspace" : requested;
    if (logical.startsWith(BOX_TERMINAL_VIRTUAL_PREFIX)) {
      const terminalName = logical.slice(BOX_TERMINAL_VIRTUAL_PREFIX.length);
      if (!/^\d+\.txt$/.test(terminalName)) throw new PathRejectedError(`Rejected terminal virtual path: ${requested}`);
      return path.join(this.terminalsDirectory, terminalName);
    }
    const mapped = logical === "/workspace"
      ? this.workspaceRoot
      : logical.startsWith("/workspace/")
        ? path.join(this.workspaceRoot, logical.slice("/workspace/".length))
        : path.isAbsolute(logical)
          ? logical
          : path.join(this.workspaceRoot, logical);
    const resolved = path.resolve(mapped);
    const relative = path.relative(this.workspaceRoot, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
    throw new PathRejectedError(`Path escapes configured workspace root: ${requested}`);
  }

  assertRealPathAllowed(target: string, requested: string): void {
    for (const allowedRoot of [this.workspaceRoot, this.terminalsDirectory]) {
      const relative = path.relative(allowedRoot, target);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
    }
    throw new PathRejectedError(`Resolved path escapes configured roots: ${requested}`);
  }

  async *execute(request: ExecServerMessage, signal: AbortSignal): AsyncGenerator<ExecStreamElement> {
    try {
      switch (request.message.case) {
        case "readArgs":
        case "redactedReadArgs": {
          const result = await this.read(request.message.value);
          const resultCase = request.message.case === "readArgs" ? "readResult" : "redactedReadResult";
          yield client(request.id, request.execId, { case: resultCase, value: result } as ExecClientMessage["message"]);
          break;
        }
        case "shellArgs":
        case "miniSweAgentBashArgs": {
          const result = await this.shell(request.message.value, signal);
          const resultCase = request.message.case === "shellArgs" ? "shellResult" : "miniSweAgentBashResult";
          yield client(request.id, request.execId, { case: resultCase, value: result } as ExecClientMessage["message"]);
          break;
        }
        case "shellStreamArgs":
          yield* this.shellStream(request, request.message.value, signal);
          break;
        case "backgroundShellSpawnArgs":
          yield client(request.id, request.execId, { case: "backgroundShellSpawnResult", value: await this.spawnBackground(request.message.value) });
          break;
        case "writeShellStdinArgs":
          yield client(request.id, request.execId, { case: "writeShellStdinResult", value: await this.writeStdin(request.message.value) });
          break;
        default:
          yield thrown(request.id, `Unsupported ExecServerMessage case: ${request.message.case ?? "unset"}`, "BOX_EXEC_UNSUPPORTED");
      }
    } catch (error) {
      yield thrown(request.id, error);
    } finally {
      yield close(request.id);
    }
  }

  async read(args: ReadArgs): Promise<ReadResult> {
    try {
      const target = this.resolvePath(args.path);
      const directInfo = await lstat(target);
      if (directInfo.isSymbolicLink()) throw new PathRejectedError(`Symbolic-link reads are not permitted: ${args.path}`);
      const canonical = await realpath(target);
      this.assertRealPathAllowed(canonical, args.path);
      const info = await stat(canonical);
      if (!info.isFile()) return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: args.path, reason: "Path is not a regular file" }) } });
      if (args.encodingHint != null && args.encodingHint !== "utf8" && args.encodingHint !== "utf-8" && args.encodingHint !== "latin1") {
        return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: args.path, reason: `Unsupported encoding hint: ${args.encodingHint}` }) } });
      }
      const data = await readFile(canonical);
      const text = data.toString(args.encodingHint === "latin1" ? "latin1" : "utf8");
      const lines = text.split("\n");
      const offset = Math.max(0, args.offset ?? 0);
      const limit = args.limit == null ? lines.length : Math.max(0, args.limit);
      const content = lines.slice(offset, offset + limit).join("\n");
      return new ReadResult({ result: { case: "success", value: new ReadSuccess({
        path: args.path,
        output: { case: "content", value: content },
        totalLines: lines.length,
        fileSize: BigInt(data.byteLength),
        truncated: offset > 0 || offset + limit < lines.length,
        rangeApplied: args.offset != null || args.limit != null,
      }) } });
    } catch (error) {
      if (error instanceof PathRejectedError) return new ReadResult({ result: { case: "rejected", value: new ReadRejected({ path: args.path, reason: error.message }) } });
      const code = typeof error === "object" && error != null && "code" in error ? String(error.code) : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") return new ReadResult({ result: { case: "fileNotFound", value: new ReadFileNotFound({ path: args.path }) } });
      if (code === "EACCES" || code === "EPERM") return new ReadResult({ result: { case: "permissionDenied", value: new ReadPermissionDenied({ path: args.path }) } });
      if (code === "EISDIR" || code === "EINVAL" || code === "ENAMETOOLONG") return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: args.path, reason: errorText(error) }) } });
      return new ReadResult({ result: { case: "error", value: new ReadError({ path: args.path, error: errorText(error) }) } });
    }
  }

  async shell(args: ShellArgs, signal: AbortSignal): Promise<ShellResult> {
    let cwd: string;
    try {
      cwd = this.resolvePath(args.workingDirectory);
    } catch (error) {
      return new ShellResult({ result: { case: "spawnError", value: new ShellSpawnError({ command: args.command, workingDirectory: args.workingDirectory, error: errorText(error) }) } });
    }
    const outcome = await this.run(args.command, cwd, args.timeout > 0 ? args.timeout : undefined, signal);
    if (outcome.timedOut) return new ShellResult({ result: { case: "timeout", value: new ShellTimeout({ command: args.command, workingDirectory: args.workingDirectory, timeoutMs: args.timeout }) } });
    const common = {
      command: args.command,
      workingDirectory: args.workingDirectory,
      exitCode: outcome.code,
      signal: outcome.signal,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      executionTime: outcome.elapsedMs,
      interleavedOutput: `${outcome.stdout}${outcome.stderr}`,
      localExecutionTimeMs: outcome.elapsedMs,
    };
    return outcome.code === 0 && !outcome.aborted
      ? new ShellResult({ result: { case: "success", value: new ShellSuccess(common) } })
      : new ShellResult({ result: { case: "failure", value: new ShellFailure({ ...common, aborted: outcome.aborted }) } });
  }

  async *shellStream(request: ExecServerMessage, args: ShellArgs, signal: AbortSignal): AsyncGenerator<ExecStreamElement> {
    const cwd = this.resolvePath(args.workingDirectory);
    yield client(request.id, request.execId, { case: "shellStream", value: new ShellStream({ event: { case: "start", value: new ShellStreamStart() } }) });
    const child = this.spawnShell(args.command, cwd);
    this.#foreground.add(child);
    const startedAt = Date.now();
    const events: Array<{ case: "stdout" | "stderr"; data: string }> = [];
    let wake: (() => void) | undefined;
    let done = false;
    let exitCode = 1;
    let exitSignal = "";
    const notify = () => { wake?.(); wake = undefined; };
    child.stdout.on("data", data => { events.push({ case: "stdout", data: String(data) }); notify(); });
    child.stderr.on("data", data => { events.push({ case: "stderr", data: String(data) }); notify(); });
    child.once("close", (code, childSignal) => { exitCode = code ?? 1; exitSignal = childSignal ?? ""; done = true; notify(); });
    const abort = () => this.kill(child);
    signal.addEventListener("abort", abort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    if (args.timeout > 0) timer = setTimeout(() => this.kill(child), args.timeout);
    try {
      while (!done || events.length > 0) {
        while (events.length > 0) {
          const event = events.shift()!;
          yield client(request.id, request.execId, {
            case: "shellStream",
            value: new ShellStream({ event: event.case === "stdout"
              ? { case: "stdout", value: new ShellStreamStdout({ data: event.data }) }
              : { case: "stderr", value: new ShellStreamStderr({ data: event.data }) } }),
          });
        }
        if (!done) await new Promise<void>(resolve => { wake = resolve; });
      }
      yield client(request.id, request.execId, { case: "shellStream", value: new ShellStream({ event: { case: "exit", value: new ShellStreamExit({
        code: exitCode,
        cwd: args.workingDirectory,
        aborted: signal.aborted,
        localExecutionTimeMs: Date.now() - startedAt,
      }) } }) });
      void exitSignal;
    } finally {
      if (timer != null) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.#foreground.delete(child);
      if (!done) this.kill(child);
    }
  }

  async spawnBackground(args: BackgroundShellSpawnArgs): Promise<BackgroundShellSpawnResult> {
    try {
      const cwd = this.resolvePath(args.workingDirectory);
      await mkdir(this.terminalsDirectory, { recursive: true });
      const shellId = this.#nextShellId++;
      const terminalPath = path.join(this.terminalsDirectory, `${shellId}.txt`);
      const startedAt = Date.now();
      const child = this.spawnShell(args.command, cwd);
      const process: BackgroundProcess = {
        child,
        terminalPath,
        startedAt,
        writeQueue: writeFile(terminalPath, terminalFrontmatter(args, child.pid, startedAt)),
      };
      this.#background.set(shellId, process);
      const queueWrite = (data: string | Uint8Array) => {
        process.writeQueue = process.writeQueue.then(() => appendFile(terminalPath, data));
      };
      child.stdout.on("data", data => { queueWrite(data); });
      child.stderr.on("data", data => { queueWrite(data); });
      child.once("close", code => {
        this.#background.delete(shellId);
        queueWrite(terminalFooter(code ?? 1, startedAt));
      });
      return new BackgroundShellSpawnResult({ result: { case: "success", value: new BackgroundShellSpawnSuccess({ shellId, command: args.command, workingDirectory: args.workingDirectory, ...(child.pid == null ? {} : { pid: child.pid }) }) } });
    } catch (error) {
      return new BackgroundShellSpawnResult({ result: { case: "error", value: new BackgroundShellSpawnError({ command: args.command, workingDirectory: args.workingDirectory, error: errorText(error) }) } });
    }
  }

  async writeStdin(args: WriteShellStdinArgs): Promise<WriteShellStdinResult> {
    const running = this.#background.get(args.shellId);
    if (running == null) return new WriteShellStdinResult({ result: { case: "error", value: new WriteShellStdinError({ error: `Shell ${args.shellId} is not running` }) } });
    const before = Number((await stat(running.terminalPath)).size);
    await new Promise<void>((resolve, reject) => running.child.stdin.write(args.chars, error => error == null ? resolve() : reject(error)));
    return new WriteShellStdinResult({ result: { case: "success", value: new WriteShellStdinSuccess({ shellId: args.shellId, terminalFileLengthBeforeInputWritten: before }) } });
  }

  async stop(): Promise<void> {
    for (const child of this.#foreground) this.kill(child);
    for (const process of this.#background.values()) this.kill(process.child);
    this.#foreground.clear();
    this.#background.clear();
  }

  private spawnShell(command: string, cwd: string): ChildProcessWithoutNullStreams {
    return spawn("/bin/sh", ["-lc", command], { cwd, env: this.#environment, detached: process.platform !== "win32", stdio: "pipe" });
  }

  private kill(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode != null || child.signalCode != null) return;
    try {
      if (process.platform !== "win32" && child.pid != null) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {}
  }

  private async run(command: string, cwd: string, timeoutMs: number | undefined, signal: AbortSignal): Promise<ProcessOutcome> {
    const child = this.spawnShell(command, cwd);
    this.#foreground.add(child);
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    const abort = () => this.kill(child);
    signal.addEventListener("abort", abort, { once: true });
    const timer = timeoutMs == null ? undefined : setTimeout(() => { timedOut = true; this.kill(child); }, timeoutMs);
    try {
      const outcome = await new Promise<{ code: number; signal: string }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, childSignal) => resolve({ code: code ?? 1, signal: childSignal ?? "" }));
      });
      return { ...outcome, stdout, stderr, elapsedMs: Date.now() - startedAt, timedOut, aborted: signal.aborted };
    } finally {
      if (timer != null) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.#foreground.delete(child);
    }
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error == null ? resolve() : reject(error)));
}

export async function startBoxExecDaemon(options: BoxExecDaemonOptions): Promise<BoxExecDaemonHandle> {
  const host = options.host ?? BOX_EXEC_DAEMON_HOST;
  const port = options.port ?? BOX_EXEC_DAEMON_PORT;
  const authToken = options.authToken ?? BOX_EXEC_DAEMON_AUTH_TOKEN;
  const requestedWorkspaceRoot = path.resolve(options.workspaceRoot);
  const requestedTerminalsDirectory = path.resolve(options.terminalsDirectory ?? path.join(tmpdir(), "sand-box-terminals"));
  await mkdir(requestedWorkspaceRoot, { recursive: true });
  await mkdir(requestedTerminalsDirectory, { recursive: true });
  const [workspaceRoot, terminalsDirectory] = await Promise.all([
    realpath(requestedWorkspaceRoot),
    realpath(requestedTerminalsDirectory),
  ]);
  await stat(workspaceRoot).then(info => {
    if (!info.isDirectory()) throw new Error(`workspaceRoot is not a directory: ${workspaceRoot}`);
  });
  const runtime = new BoxExecRuntime(workspaceRoot, terminalsDirectory, options.environment ?? process.env);
  const adapter = connectNodeAdapter({
    routes(router) {
      router.service(BoxControlService, {
        ping: async () => new PingResponse(),
        getCapabilities: async () => new GetCapabilitiesResponse({ computerUseSupported: false, installPluginArtifactSupported: false }),
        updateEnvironmentVariables: async request => new UpdateEnvironmentVariablesResponse(runtime.applyEnvironment(request)),
        loadMcpServers: async () => new LoadMcpServersResponse(),
      });
      router.service(BoxExecService, { exec: (request, context) => runtime.execute(request, context.signal) });
    },
  });
  let readyState = false;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${authToken}`) {
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      response.end("Unauthorized");
      return;
    }
    adapter(request, response);
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); readyState = true; resolve(); });
  });
  await ready;
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Box exec daemon did not expose a TCP address");
  let stopped = false;
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    workspaceRoot,
    terminalsDirectory,
    ready,
    isReady: () => readyState && !stopped,
    async stop() {
      if (stopped) return;
      stopped = true;
      readyState = false;
      await runtime.stop();
      await closeServer(server);
    },
  };
}
