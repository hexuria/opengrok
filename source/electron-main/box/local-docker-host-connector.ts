import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import type { RecreateResult } from "./box-recreate-commands.js";
import type { SandRemoteHostConnector } from "./box-host-connector.js";
import { formatAccountComputerError, noteAccountComputerStatus } from "./account-computer-status.js";
import { DOCKER_CLI_NOT_FOUND, DOCKER_DESKTOP_APP, classifyDockerUnavailable, dockerCliCandidates, dockerSearchPath } from "./docker-cli.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";
import { chooseLocalHostTarget } from "./local-host-target.js";
import { dispatchComputerReset } from "./computer-reset-route.js";

export const LOCAL_DOCKER_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
export const LOCAL_DOCKER_BOX_CONTAINER = "grok-bot-local-vm";
export const LOCAL_DOCKER_GATEWAY_URL = "http://127.0.0.1:1340";
export const DESKTOP_HOST_PORT = 1350;
export const DESKTOP_HOST_URL = `http://127.0.0.1:${DESKTOP_HOST_PORT}`;
export const LOCAL_DOCKER_OWNER_LABEL = "com.grok-bot.local-vm=1";
export const LOCAL_DOCKER_SCHEMA_VERSION = "6";
const READY_TIMEOUT_MS = 180_000;
const DESKTOP_HOST_READY_TIMEOUT_MS = 30_000;
const EXISTING_VM_RECONNECT_TIMEOUT_MS = 30_000;
const OPTIONAL_CREDENTIAL_TIMEOUT_MS = 3_000;

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function noteConnector(settingsPath: string, message: string): Promise<void> {
  await appendFile(join(dirname(settingsPath), "host-connector.log"), `${new Date().toISOString()} ${message}\n`).catch(() => {});
}

export interface LocalDockerStatus {
  readonly available: boolean;
  readonly running: boolean;
  readonly ready: boolean;
  readonly containerName: string;
  readonly image: string;
  readonly detail: string;
}

interface CommandResult { readonly ok: boolean; readonly output: string }
interface InferenceCredential { readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number }
interface LocalHostBundle { readonly path: string; readonly sha256: string; readonly boxExecDaemonPath: string; readonly boxExecDaemonSha256: string }

async function isPresentFile(target: string): Promise<boolean> {
  try { return (await stat(target)).isFile(); } catch { return false; }
}

let resolvedDockerCli: string | undefined;

async function resolveDockerCli(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): Promise<string | undefined> {
  if (resolvedDockerCli != null && await isPresentFile(resolvedDockerCli)) return resolvedDockerCli;
  for (const candidate of dockerCliCandidates(env, homeDir)) {
    if (await isPresentFile(candidate)) {
      resolvedDockerCli = candidate;
      return candidate;
    }
  }
  resolvedDockerCli = undefined;
  return undefined;
}

async function runDocker(args: readonly string[]): Promise<CommandResult> {
  const executable = await resolveDockerCli();
  if (executable == null) return { ok: false, output: DOCKER_CLI_NOT_FOUND };
  return await new Promise((settle) => {
    const child = spawn(executable, [...args], {
      env: { ...process.env, PATH: dockerSearchPath() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer): void => { output += chunk.toString(); if (output.length > 200_000) output = output.slice(-200_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => settle({ ok: false, output: `${output}\n${error.message}`.trim() }));
    child.once("close", (code) => settle({ ok: code === 0, output: output.trim() }));
  });
}

let dockerStartAttempted = false;

/** Starts Docker Desktop through LaunchServices, at most once per session. */
async function startDockerDesktopOnce(): Promise<void> {
  if (dockerStartAttempted) return;
  dockerStartAttempted = true;
  try {
    if (!(await isDirectory(DOCKER_DESKTOP_APP))) return;
    await new Promise<void>((settle) => {
      const child = spawn("/usr/bin/open", ["-g", "-a", DOCKER_DESKTOP_APP], { stdio: "ignore" });
      child.once("error", () => settle());
      child.once("close", () => settle());
    });
  } catch { /* self-heal is best effort; never let it break the status read */ }
}

/** Shapes a failed `docker info` into an actionable message, and starts the engine when it is merely down. */
async function describeDockerUnavailable(output: string): Promise<string> {
  const hasDesktopApp = await isDirectory(DOCKER_DESKTOP_APP);
  const { kind, message } = classifyDockerUnavailable(output, hasDesktopApp);
  if (kind === "engine-down") void startDockerDesktopOnce();
  return message;
}

function credentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-vm.json");
}

function inferenceCredentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-credential", "inference.json");
}

async function persistInferenceCredential(settingsPath: string, credential: InferenceCredential): Promise<string> {
  const target = inferenceCredentialPath(settingsPath);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ accessToken: credential.accessToken, expiresAtMs: credential.expiresAtMs })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  return target;
}

async function persistGatewayToken(settingsPath: string, token: string): Promise<void> {
  const target = credentialPath(settingsPath);
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as { token?: unknown };
    if (parsed.token === token) return;
  } catch {}
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ schemaVersion: 1, token }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
}

async function readOrCreateToken(settingsPath: string): Promise<string> {
  const target = credentialPath(settingsPath);
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as { token?: unknown };
    if (typeof parsed.token === "string" && parsed.token.length >= 32) return parsed.token;
  } catch {}
  const token = randomBytes(32).toString("hex");
  await persistGatewayToken(settingsPath, token);
  return token;
}

function gatewayTokenFromEnv(env: unknown): string | undefined {
  if (!Array.isArray(env)) return undefined;
  for (const entry of env) {
    if (typeof entry !== "string" || !entry.startsWith("SAND_GATEWAY_TOKEN=")) continue;
    const token = entry.slice("SAND_GATEWAY_TOKEN=".length).trim();
    if (token.length >= 32) return token;
  }
  return undefined;
}

async function tokenForExistingBox(settingsPath: string, inspectedToken?: string): Promise<string> {
  if (inspectedToken != null && inspectedToken.length >= 32) {
    await persistGatewayToken(settingsPath, inspectedToken).catch(() => undefined);
    return inspectedToken;
  }
  return await readOrCreateToken(settingsPath);
}

async function gatewayReady(token: string, baseUrl = LOCAL_DOCKER_GATEWAY_URL): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch { return false; }
}

async function inspectContainer(): Promise<{ exists: boolean; running: boolean; owned: boolean; image: string; hostSha256: string; hasInferenceCredential: boolean; schemaVersion: string; gatewayToken?: string }> {
  const result = await runDocker(["inspect", "--format", "{{json .}}", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!result.ok) return { exists: false, running: false, owned: false, image: "", hostSha256: "", hasInferenceCredential: false, schemaVersion: "" };
  try {
    const value = JSON.parse(result.output) as { State?: { Running?: unknown }; Config?: { Image?: unknown; Labels?: Record<string, unknown>; Env?: unknown } };
    const gatewayToken = gatewayTokenFromEnv(value.Config?.Env);
    return {
      exists: true,
      running: value.State?.Running === true,
      owned: value.Config?.Labels?.["com.grok-bot.local-vm"] === "1",
      image: typeof value.Config?.Image === "string" ? value.Config.Image : "",
      hostSha256: typeof value.Config?.Labels?.["com.grok-bot.local-vm.host-sha256"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.host-sha256"] as string : "",
      hasInferenceCredential: value.Config?.Labels?.["com.grok-bot.local-vm.inference-credential"] === "1",
      schemaVersion: typeof value.Config?.Labels?.["com.grok-bot.local-vm.schema-version"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.schema-version"] as string : "",
      ...(gatewayToken === undefined ? {} : { gatewayToken }),
    };
  } catch { throw new Error("Docker returned malformed container inspection data."); }
}

export async function getLocalDockerStatus(settingsPath: string): Promise<LocalDockerStatus> {
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
  if (!daemon.ok) return { available: false, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: await describeDockerUnavailable(daemon.output) };
  const inspected = await inspectContainer();
  if (!inspected.exists) return { available: true, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: "Ready to create the local VM." };
  if (!inspected.owned) return { available: true, running: inspected.running, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: `Container ${LOCAL_DOCKER_BOX_CONTAINER} exists but is not owned by Grok Bot.` };
  const token = await tokenForExistingBox(settingsPath, inspected.gatewayToken);
  const ready = inspected.running && await gatewayReady(token);
  return {
    available: true,
    running: inspected.running,
    ready,
    containerName: LOCAL_DOCKER_BOX_CONTAINER,
    image: inspected.image,
    detail: inspected.running
      ? (ready ? "Local VM is running." : "Local VM is running. Connecting to its gateway…")
      : "Local VM is stopped.",
  };
}

let ensureInFlight: Promise<GatewayConnection> | undefined;

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function stageCurrentHostBundle(settingsPath: string): Promise<LocalHostBundle> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const readRuntime = async (relative: string): Promise<Buffer> => {
    const candidates = [resolve(moduleDirectory, `../${relative}`), resolve(moduleDirectory, `../../${relative}`)];
    for (const candidate of candidates) {
      try { return await readFile(candidate); } catch {}
    }
    throw new Error(`The reconstructed runtime is unavailable at ${candidates.join(" or ")}; refusing to start a stock local VM.`);
  };
  const hostBytes = await readRuntime("host/host-main.cjs");
  const boxExecDaemonBytes = await readRuntime("box-exec-daemon/main.cjs");
  const sha256 = createHash("sha256").update(hostBytes).digest("hex");
  const boxExecDaemonSha256 = createHash("sha256").update(boxExecDaemonBytes).digest("hex");
  const directory = join(dirname(settingsPath), "local-docker-runtime", `${sha256}-${boxExecDaemonSha256}`);
  const persistRuntime = async (name: string, bytes: Buffer): Promise<string> => {
    const target = join(directory, name);
    await mkdir(dirname(target), { recursive: true });
    try {
      const existing = await readFile(target);
      if (!existing.equals(bytes)) throw new Error(`Content-addressed local runtime ${target} has unexpected bytes.`);
    } catch (error) {
      if (error instanceof Error && !Reflect.has(error, "code")) throw error;
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, target);
    }
    return target;
  };
  await mkdir(directory, { recursive: true });
  return {
    path: await persistRuntime("host-main.cjs", hostBytes),
    sha256,
    boxExecDaemonPath: await persistRuntime("box-exec-daemon/main.cjs", boxExecDaemonBytes),
    boxExecDaemonSha256,
  };
}

let desktopHostProcess: ChildProcess | undefined;

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    const names = await readdir(path);
    return names.some((name) => name !== "." && name !== ".." && !name.startsWith("."));
  } catch {
    return false;
  }
}

async function importAgentsFromDockerIfNeeded(dataRoot: string): Promise<void> {
  if (await directoryHasEntries(join(dataRoot, "agents"))) return;
  const inspected = await inspectContainer();
  if (!inspected.exists || !inspected.running) return;
  await mkdir(join(dataRoot, "agents"), { recursive: true });
  await runDocker(["cp", `${LOCAL_DOCKER_BOX_CONTAINER}:/home/box/sand-data/agents/.`, join(dataRoot, "agents")]);
  await mkdir(join(dataRoot, "agent-transcripts"), { recursive: true });
  await runDocker(["cp", `${LOCAL_DOCKER_BOX_CONTAINER}:/home/box/sand-data/agent-transcripts/.`, join(dataRoot, "agent-transcripts")]);
}

export async function ensureDesktopHost(
  settingsPath: string,
  inferenceCredential?: InferenceCredential,
): Promise<GatewayConnection> {
  const token = await readOrCreateToken(settingsPath);
  if (await gatewayReady(token, DESKTOP_HOST_URL)) return { baseUrl: DESKTOP_HOST_URL, token };
  const dataRoot = dirname(settingsPath);
  await importAgentsFromDockerIfNeeded(dataRoot);
  const hostBundle = await stageCurrentHostBundle(settingsPath);
  const inferenceFile = inferenceCredential == null ? undefined : await persistInferenceCredential(settingsPath, inferenceCredential);
  if (desktopHostProcess != null && desktopHostProcess.exitCode == null) {
    desktopHostProcess.kill("SIGTERM");
    desktopHostProcess = undefined;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    SAND_HOST_PORT: String(DESKTOP_HOST_PORT),
    SAND_GATEWAY_BIND_HOST: "127.0.0.1",
    SAND_GATEWAY_TOKEN: token,
    SAND_GATEWAY_REQUIRE_AUTH: "1",
    SAND_DATA_ROOT: dataRoot,
    SAND_PACKAGED: "1",
    SAND_BOX_AUTO_UPDATE: "0",
    SAND_USE_EXISTING_BOX_EXEC_DAEMON: "1",
  };
  if (inferenceFile != null && inferenceCredential != null) {
    env.SAND_DEV_INFERENCE_TOKEN_FILE = inferenceFile;
    env.SAND_BACKEND_URL = inferenceCredential.backendUrl;
  }
  const logPath = join(dataRoot, "desktop-host.log");
  await appendFile(logPath, `${new Date().toISOString()} spawning ${hostBundle.path} on ${DESKTOP_HOST_PORT}\n`).catch(() => {});
  const logFd = openSync(logPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [hostBundle.path], {
      env,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
  } finally {
    closeSync(logFd);
  }
  desktopHostProcess = child;
  child.once("error", (error) => { void appendFile(logPath, `spawn error: ${error.message}\n`).catch(() => {}); });
  child.once("exit", (code, signal) => {
    void appendFile(logPath, `exited code=${code} signal=${signal}\n`).catch(() => {});
    if (desktopHostProcess === child) desktopHostProcess = undefined;
  });
  child.unref();
  const deadline = Date.now() + DESKTOP_HOST_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gatewayReady(token, DESKTOP_HOST_URL)) return { baseUrl: DESKTOP_HOST_URL, token };
    if (child.exitCode != null) throw new Error(`Desktop host exited before it became ready (code ${child.exitCode}).`);
    await delay(200);
  }
  throw new Error("Desktop host did not expose its gateway within 30 seconds.");
}

async function connectLocalDocker(
  settingsPath: string,
  issueInferenceCredential?: () => Promise<InferenceCredential | undefined>,
): Promise<GatewayConnection> {
  let inspected: Awaited<ReturnType<typeof inspectContainer>> | undefined;
  try { inspected = await inspectContainer(); } catch { inspected = undefined; }
  const token = await tokenForExistingBox(settingsPath, inspected?.gatewayToken);
  const dockerReady = await gatewayReady(token, LOCAL_DOCKER_GATEWAY_URL);
  const dockerContainerRunning = dockerReady || inspected?.running === true;
  const target = chooseLocalHostTarget({
    dockerGatewayReady: dockerReady,
    desktopGatewayReady: false,
    dockerContainerRunning,
  });
  await noteConnector(settingsPath, `target=${target} dockerReady=${dockerReady} desktopReady=false containerRunning=${dockerContainerRunning}`);
  if (target === "docker-gateway") return { baseUrl: LOCAL_DOCKER_GATEWAY_URL, token };
  if (target === "wait-docker-gateway") {
    const deadline = Date.now() + EXISTING_VM_RECONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await gatewayReady(token, LOCAL_DOCKER_GATEWAY_URL)) return { baseUrl: LOCAL_DOCKER_GATEWAY_URL, token };
      await delay(250);
    }
  }
  const issued = issueInferenceCredential == null ? undefined : await issueInferenceCredential();
  return await ensureLocalDockerBox(settingsPath, issued);
}

async function localAuthMountArguments(): Promise<string[]> {
  const mounts: string[] = [];
  for (const [source, destination] of [[join(homedir(), ".codex"), "/root/.codex"], [join(homedir(), ".claude"), "/root/.claude"]] as const) {
    if (await isDirectory(source)) mounts.push("--mount", `type=bind,src=${source},dst=${destination},readonly`);
  }
  return mounts;
}

async function ensureLocalDockerBox(settingsPath: string, inferenceCredential?: InferenceCredential): Promise<GatewayConnection> {
  const inspected = await inspectContainer();
  const token = await tokenForExistingBox(settingsPath, inspected.gatewayToken);
  if (await gatewayReady(token)) return { baseUrl: LOCAL_DOCKER_GATEWAY_URL, token };
  const hostBundle = await stageCurrentHostBundle(settingsPath);
  const inferenceFile = inferenceCredential == null ? undefined : await persistInferenceCredential(settingsPath, inferenceCredential);
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
  if (!daemon.ok) throw new Error(await describeDockerUnavailable(daemon.output));
  if (inspected.exists && !inspected.owned) throw new Error(`Local Docker VM cannot use ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.`);
  if (inspected.exists && inspected.image !== LOCAL_DOCKER_BOX_IMAGE) throw new Error(`Local Docker VM container uses unexpected image ${inspected.image}. Remove it explicitly before changing images.`);
  const current = inspected;
  if (current.exists && !current.running) {
    await noteConnector(settingsPath, `target=docker-start container=${LOCAL_DOCKER_BOX_CONTAINER}`);
    const started = await runDocker(["start", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!started.ok) throw new Error(`Could not start the local Docker VM: ${started.output}`);
  } else if (!current.exists) {
    const authMounts = await localAuthMountArguments();
    const created = await runDocker([
      "run", "--detach", "--name", LOCAL_DOCKER_BOX_CONTAINER,
      "--label", LOCAL_DOCKER_OWNER_LABEL, "--label", `com.grok-bot.local-vm.host-sha256=${hostBundle.sha256}`,
      "--label", `com.grok-bot.local-vm.box-exec-daemon-sha256=${hostBundle.boxExecDaemonSha256}`,
      "--label", `com.grok-bot.local-vm.inference-credential=${inferenceCredential == null ? "0" : "1"}`,
      "--label", `com.grok-bot.local-vm.schema-version=${LOCAL_DOCKER_SCHEMA_VERSION}`,
      "--platform", "linux/amd64", "--restart", "unless-stopped",
      "--env", "SAND_SUPERVISOR_ENABLED=1", "--env", "SAND_BOX_AUTO_UPDATE=0", "--env", "SAND_USE_EXISTING_BOX_EXEC_DAEMON=1", "--env", "SAND_TREE_SITTER_NODE_DEPS=/home/box/deps", "--env", "NODE_PATH=/home/box/deps", "--env", "SAND_GATEWAY_BIND_HOST=0.0.0.0", "--env", "SAND_HOST_PORT=1340", "--env", `SAND_GATEWAY_TOKEN=${token}`,
      ...(inferenceCredential == null ? [] : ["--env", "SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json", "--env", `SAND_BACKEND_URL=${inferenceCredential.backendUrl}`]),
      "--publish", "127.0.0.1:1337:1337", "--publish", "127.0.0.1:1339:1339", "--publish", "127.0.0.1:1340:1340",
      "--publish", "127.0.0.1:6080:6080", "--publish", "127.0.0.1:6081:6081", "--publish", "127.0.0.1:8790:8790",
      "--volume", "grok-bot-local-vm-workspace:/workspace", "--volume", "grok-bot-local-vm-data:/home/box/sand-data",
      "--mount", `type=bind,src=${hostBundle.path},dst=/home/box/sand-host/host-main.cjs,readonly`,
      "--mount", `type=bind,src=${dirname(hostBundle.boxExecDaemonPath)},dst=/home/box/box-exec-daemon,readonly`,
      ...(inferenceFile == null ? [] : ["--mount", `type=bind,src=${dirname(inferenceFile)},dst=/run/grok-bot,readonly`]),
      ...authMounts,
      LOCAL_DOCKER_BOX_IMAGE,
    ]);
    if (!created.ok) throw new Error(`Could not create the local Docker VM: ${created.output}`);
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gatewayReady(token)) return { baseUrl: LOCAL_DOCKER_GATEWAY_URL, token };
    const state = await inspectContainer();
    if (!state.running) {
      const logs = await runDocker(["logs", "--tail", "80", LOCAL_DOCKER_BOX_CONTAINER]);
      throw new Error(`Local Docker VM stopped before its gateway became ready.\n${logs.output}`);
    }
    await delay(1_000);
  }
  throw new Error("Local Docker VM did not expose its gateway within three minutes.");
}

export async function startLocalDockerBox(settingsPath: string): Promise<GatewayConnection> {
  return await ensureLocalDockerBox(settingsPath);
}

export async function stopLocalDockerBox(): Promise<void> {
  const inspected = await inspectContainer();
  if (!inspected.exists || !inspected.running) return;
  if (!inspected.owned) throw new Error(`Refusing to stop unowned container ${LOCAL_DOCKER_BOX_CONTAINER}.`);
  const stopped = await runDocker(["stop", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!stopped.ok) throw new Error(`Could not stop the local Docker VM: ${stopped.output}`);
}

export function createSettingsRoutedHostConnector(
  remote: SandRemoteHostConnector,
  settings: SandSettingsStore,
): SandRemoteHostConnector {
  const localConnect = (): Promise<GatewayConnection> => {
    if (ensureInFlight == null) ensureInFlight = connectLocalDocker(settings.settingsPath, async () => {
      if (remote.issueInferenceCredential == null) return undefined;
      return await Promise.race([
        remote.issueInferenceCredential(),
        new Promise<undefined>((resolve) => setTimeout(resolve, OPTIONAL_CREDENTIAL_TIMEOUT_MS)),
      ]);
    }).finally(() => { ensureInFlight = undefined; });
    return ensureInFlight;
  };
  return {
    connect: async () => {
      const runtime = settings.getBoxRuntime();
      if (runtime === "local-docker") return await localConnect();
      // Leave grok-bot-local-vm running so Local VM can attach to the existing container.
      if (runtime === "windows365") {
        await noteConnector(settings.settingsPath, "target=windows365-via-account-computer").catch(() => undefined);
      } else {
        await noteConnector(settings.settingsPath, "target=account-computer").catch(() => undefined);
      }
      try {
        const connection = await remote.connect();
        let gatewayHost: string | null = null;
        try { gatewayHost = new URL(connection.baseUrl).host; } catch { gatewayHost = connection.baseUrl; }
        if (gatewayHost != null && (gatewayHost.startsWith("127.0.0.1") || gatewayHost.startsWith("localhost"))) {
          throw new Error("Account computer resolved to a loopback gateway; refusing to treat the local VM as Grok VM.");
        }
        noteAccountComputerStatus({
          ok: true,
          detail: `Attached the Cursor-account computer at ${gatewayHost}. Bots on that box are the same roster official Grok Bot shows.`,
          gatewayHost,
        });
        await noteConnector(settings.settingsPath, `target=account-computer attached=${gatewayHost}`).catch(() => undefined);
        return connection;
      } catch (error) {
        const detail = formatAccountComputerError(error);
        noteAccountComputerStatus({ ok: false, detail, gatewayHost: null });
        await noteConnector(settings.settingsPath, `target=account-computer error=${detail}`).catch(() => undefined);
        throw error;
      }
    },
    ...(remote.issueLocalExecDaemonCredential == null ? {} : { issueLocalExecDaemonCredential: remote.issueLocalExecDaemonCredential.bind(remote) }),
    ...(remote.issueInferenceCredential == null ? {} : { issueInferenceCredential: remote.issueInferenceCredential.bind(remote) }),
    recreate: async (args): Promise<RecreateResult> => {
      const routed = await dispatchComputerReset({
        runtime: settings.getBoxRuntime(),
        hosted: async () => {
          if (remote.recreate == null) throw new Error("Remote Grok VM recreation is unavailable.");
          return await remote.recreate(args);
        },
        localDocker: async () => {
          const inspected = await inspectContainer();
          if (inspected.exists) {
            const restarted = await runDocker(["restart", LOCAL_DOCKER_BOX_CONTAINER]);
            if (!restarted.ok) throw new Error(`Could not restart the local Docker VM: ${restarted.output}`);
          }
          await ensureLocalDockerBox(settings.settingsPath);
          return { status: "started-untrackable" as const };
        },
      });
      if (routed.status === "rejected") throw new Error(routed.reason);
      return routed;
    },
    forceRecreate: async (): Promise<RecreateResult> => {
      return await dispatchComputerReset({
        runtime: settings.getBoxRuntime(),
        hosted: async () => {
          if (remote.forceRecreate == null) return { status: "rejected" as const, reason: "Remote Grok VM reset is unavailable." };
          return await remote.forceRecreate();
        },
        localDocker: async () => {
          const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
          if (!removed.ok && !/no such container/i.test(removed.output)) return { status: "rejected" as const, reason: removed.output };
          await ensureLocalDockerBox(settings.settingsPath);
          return { status: "started-untrackable" as const };
        },
      });
    },
  };
}
