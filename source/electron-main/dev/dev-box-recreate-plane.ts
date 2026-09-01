import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getSandRootDir } from "../../host/host-paths.js";
import { isDevControlsEnabled } from "./dev-controls-gate.js";
import type { BoxConnectionInfo } from "../../shared/node/egress-tunnel/box-connection.js";
import type { RecreateResult } from "../box/box-recreate-commands.js";

export class SandDevBoxRecreateError extends Error {}
export const PROD_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
export const GATEWAY_PROBE_TIMEOUT_MS = 3_000;
export const FLUSH_TIMEOUT_MS = 30_000;
export const COPY_IN_OUTCOME_TIMEOUT_MS = 90_000;
export const COPY_IN_OUTCOME_POLL_MS = 2_000;

export interface DevBoxControlPlaneConfig {
  readonly containerName: string;
  readonly image: string;
  readonly imageIsPullable: boolean;
  readonly gatewayUrl: string;
  readonly devBoxRoot: string;
  readonly dockerSocketPath: string;
}

export function isCloudVm(env: NodeJS.ProcessEnv): boolean {
  const truthy = (value: string | undefined): boolean => value != null && ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return truthy(env.IS_CLOUD_AGENT) || truthy(env.EVERYSPHERE_DEV_IN_CLOUD) || truthy(env.SAND_DEV_BOX_CGROUPNS_HOST);
}

export function isPullableImageReference(image: string): boolean {
  const firstSegment = image.split("/")[0] ?? "";
  return image.includes("/") && (firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost");
}

export function resolveDevBoxControlPlaneConfig(
  env: NodeJS.ProcessEnv,
  options: { readonly isPackaged?: boolean; readonly devBoxRoot?: string } = {},
): DevBoxControlPlaneConfig | null {
  if (!isDevControlsEnabled({ isPackaged: options.isPackaged ?? false })) return null;
  if (env.SAND_DEV_BOX_CONTROL_PLANE === "0") return null;
  const gatewayUrl = env.SAND_HOST_GATEWAY_URL?.trim() ?? "";
  if (gatewayUrl.length === 0) return null;
  let gatewayHost: string;
  try { gatewayHost = new URL(gatewayUrl).hostname; } catch { return null; }
  if (gatewayHost !== "127.0.0.1" && gatewayHost !== "localhost") return null;
  const image = env.SAND_BOX_IMAGE ?? (isCloudVm(env) ? PROD_BOX_IMAGE : "sand-box:local");
  return {
    containerName: env.SAND_DEV_BOX_CONTAINER ?? "sand-dev-box",
    image,
    imageIsPullable: isPullableImageReference(image),
    gatewayUrl,
    devBoxRoot: options.devBoxRoot ?? path.join(getSandRootDir(), "dev-box"),
    dockerSocketPath: env.SAND_DEV_BOX_DOCKER_SOCKET ?? "/var/run/docker.sock",
  };
}

export interface PullProgressEvent {
  readonly status?: string;
  readonly id?: string;
  readonly progressDetail?: { readonly current?: number; readonly total?: number };
  readonly error?: string;
}
export function createPullProgressAggregator(): { ingest(event: PullProgressEvent): number | null } {
  const layers = new Map<string, { current: number; total: number }>();
  let lastPercent = 0;
  return {
    ingest(event) {
      if (event.status === "Downloading" && event.id != null) {
        const detail = event.progressDetail;
        if (detail?.total != null && detail.total > 0) layers.set(event.id, { current: Math.min(detail.current ?? 0, detail.total), total: detail.total });
      } else if ((event.status === "Download complete" || event.status === "Pull complete") && event.id != null) {
        const layer = layers.get(event.id); if (layer != null) layer.current = layer.total;
      } else return null;
      let current = 0; let total = 0;
      for (const layer of layers.values()) { current += layer.current; total += layer.total; }
      if (total <= 0) return null;
      const percent = Math.max(1, Math.min(100, Math.floor(current / total * 100)));
      if (percent <= lastPercent) return null;
      lastPercent = percent;
      return percent;
    },
  };
}

export interface CommandResult { readonly isOk: boolean; readonly output: string }
export function runCommand(command: string, args: readonly string[], options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const append = (chunk: Buffer): void => { output += chunk.toString(); if (output.length > 200_000) output = output.slice(-200_000); };
    child.stdout?.on("data", append); child.stderr?.on("data", append);
    child.on("error", (error) => resolve({ isOk: false, output: `${output}\n${String(error)}`.trim() }));
    child.on("close", (code) => resolve({ isOk: code === 0, output: output.trim() }));
  });
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })]); }
  finally { if (timer != null) clearTimeout(timer); }
}
export function tail(text: string, maxLength: number): string { return text.length <= maxLength ? text : text.slice(-maxLength); }
export function splitImageReference(image: string): readonly [string, string | undefined] {
  const lastColon = image.lastIndexOf(":");
  return lastColon > image.lastIndexOf("/") ? [image.slice(0, lastColon), image.slice(lastColon + 1)] : [image, undefined];
}

export interface DevBoxRecreateOps {
  probeGateway(): Promise<{ isReachable: boolean; isBusy: boolean }>;
  flushBoxStore(): Promise<"flushed" | "unavailable">;
  isStoreEnabled(): Promise<boolean>;
  removeContainer(): Promise<void>;
  imageExists(): Promise<boolean>;
  pullImage(onPercent: (percent: number) => void): Promise<void>;
  wipeSandData(): Promise<void>;
  clearStore(): Promise<void>;
  recreateContainer(options?: { readonly hydrateFromStore?: boolean }): Promise<void>;
  hasSandData(): Promise<boolean>;
  readCopyInOutcome(): Promise<string | null>;
}

export function pullImageViaEngine(config: DevBoxControlPlaneConfig, onPercent: (percent: number) => void): Promise<void> {
  const [imageName, tag = "latest"] = splitImageReference(config.image);
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: config.dockerSocketPath, method: "POST", path: `/images/create?fromImage=${encodeURIComponent(imageName)}&tag=${encodeURIComponent(tag)}`, headers: { "Content-Type": "application/json" } }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`engine pull returned HTTP ${response.statusCode}`)); return; }
      const aggregator = createPullProgressAggregator(); let buffered = ""; let failure: Error | null = null;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffered += chunk; const lines = buffered.split("\n"); buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          let event: PullProgressEvent;
          try { event = JSON.parse(line) as PullProgressEvent; } catch { continue; }
          if (typeof event.error === "string" && event.error.length > 0) { failure = new Error(event.error); continue; }
          const percent = aggregator.ingest(event); if (percent != null) onPercent(percent);
        }
      });
      response.on("end", () => { if (failure != null) reject(failure); else { onPercent(100); resolve(); } });
      response.on("error", reject);
    });
    request.on("error", reject); request.end();
  });
}

export function createDevBoxRecreateOps(options: {
  readonly config: DevBoxControlPlaneConfig;
  log(message: string): void;
  reportFailure?(surface: "dev-box", operation: string, error: unknown): void;
  readonly moduleUrl?: string;
}): DevBoxRecreateOps {
  const { config, log } = options;
  const sandDir = path.resolve(path.dirname(fileURLToPath(options.moduleUrl ?? import.meta.url)), "..", "..", "..");
  const script = path.join(sandDir, "scripts", "dev-box-docker.mjs");
  const runScript = async (subcommand: string): Promise<CommandResult> => {
    const result = await runCommand(process.execPath, [script, subcommand], { cwd: sandDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    log(`dev-box-docker ${subcommand}: ${result.isOk ? "ok" : "FAILED"}\n${tail(result.output, 2_000)}`); return result;
  };
  const readGatewayToken = async (): Promise<string | null> => {
    const fromEnv = process.env.SAND_HOST_GATEWAY_TOKEN?.trim(); if (fromEnv) return fromEnv;
    try { const parsed = JSON.parse(await readFile(path.join(config.devBoxRoot, "gateway.json"), "utf8")) as { gatewayToken?: unknown }; return typeof parsed.gatewayToken === "string" ? parsed.gatewayToken : null; } catch { return null; }
  };
  return {
    async probeGateway() {
      try {
        const response = await withTimeout(fetch(`${config.gatewayUrl}/health`), GATEWAY_PROBE_TIMEOUT_MS);
        if (!response.ok) return { isReachable: false, isBusy: false };
        let isBusy = false; try { isBusy = ((await response.json()) as { isBusy?: unknown }).isBusy === true; } catch (error) { options.reportFailure?.("dev-box", "health-body", error); }
        return { isReachable: true, isBusy };
      } catch { return { isReachable: false, isBusy: false }; }
    },
    async flushBoxStore() {
      const token = await readGatewayToken(); if (token == null) return "unavailable";
      try {
        const response = await withTimeout(fetch(`${config.gatewayUrl}/api/snapshotBoxStoreNow`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ includeIdleOnly: true }) }), FLUSH_TIMEOUT_MS);
        return response.ok ? "flushed" : "unavailable";
      } catch { return "unavailable"; }
    },
    async isStoreEnabled() { try { return (await readFile(path.join(config.devBoxRoot, "box-store-id"), "utf8")).trim().length > 0; } catch { return false; } },
    async removeContainer() {
      try { await writeFile(path.join(config.devBoxRoot, "recreate-intent.json"), JSON.stringify({ writtenAtMs: Date.now() })); } catch (error) { options.reportFailure?.("dev-box", "recreate-intent", error); }
      const result = await runCommand("docker", ["rm", "-f", config.containerName]);
      if (!result.isOk && !/no such container/i.test(result.output)) throw new SandDevBoxRecreateError(`docker rm -f ${config.containerName} failed: ${result.output}`);
    },
    async imageExists() { return (await runCommand("docker", ["image", "inspect", config.image])).isOk; },
    async pullImage(onPercent) {
      if (!config.imageIsPullable) throw new SandDevBoxRecreateError(`box image ${config.image} is local-only and absent; rebuild it with \`pnpm --filter sand dev:box\` first.`);
      log(`pulling ${config.image}…`);
      try { await pullImageViaEngine(config, onPercent); log(`pull of ${config.image} complete.`); return; }
      catch (error) { log(`engine pull stream unavailable (${String(error)}); falling back to \`docker pull\` (no live progress).`); }
      const result = await runCommand("docker", ["pull", config.image]);
      if (!result.isOk) throw new SandDevBoxRecreateError(`docker pull ${config.image} failed: ${tail(result.output, 2_000)}`);
    },
    async wipeSandData() { const result = await runScript("wipe-data"); if (!result.isOk) throw new SandDevBoxRecreateError(`wiping sand-data failed: ${tail(result.output, 2_000)}`); },
    async clearStore() { const result = await runScript("clear-store"); if (!result.isOk) throw new SandDevBoxRecreateError(`clearing the box store failed: ${tail(result.output, 2_000)}`); },
    async recreateContainer(args) { const result = await runScript(args?.hydrateFromStore === true ? "recreate-from-store" : "recreate"); if (!result.isOk) throw new SandDevBoxRecreateError(`recreating the container failed: ${tail(result.output, 2_000)}`); },
    async hasSandData() { try { const dataDir = path.join(config.devBoxRoot, "sand-data"); return (await stat(dataDir)).isDirectory() && (await readdir(dataDir)).length > 0; } catch { return false; } },
    async readCopyInOutcome() {
      const deadline = Date.now() + COPY_IN_OUTCOME_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const result = await runCommand("docker", ["exec", config.containerName, "sh", "-c", "cat /tmp/sand-copy-in.log 2>/dev/null || true"]);
        if (result.isOk) { const matches = [...result.output.matchAll(/\[box-copy-in\] result outcome=(\S+)/g)]; const outcome = matches.at(-1)?.[1]; if (outcome != null) return outcome; }
        await delay(COPY_IN_OUTCOME_POLL_MS);
      }
      return null;
    },
  };
}

export type MigrationPhase = "backing-up" | "creating" | "moving" | "cleaning-up" | "wiping" | "done" | "failed";
export interface OperationId { readonly value: string }
export interface DevBoxRecreatePlaneDependencies {
  readonly ops: DevBoxRecreateOps;
  readonly imageIsPullable: boolean;
  emitMigration(event: { readonly operationId: OperationId; readonly phase: MigrationPhase; readonly detail: string }): void;
  emitPullProgress(percent: number): void;
  log(message: string): void;
  readonly uuid?: () => string;
}

export class DevBoxRecreatePlane {
  private isRecreateInFlight = false;
  constructor(private readonly deps: DevBoxRecreatePlaneDependencies) {}

  async recreate({ preserveData, force = false }: { readonly preserveData: boolean; readonly force?: boolean }): Promise<{ status: "started"; operationId: OperationId }> {
    const action = preserveData ? "update" : "reset";
    if (this.isRecreateInFlight) throw new SandDevBoxRecreateError(actionFailureMessage(action, "another recreate is in flight"));
    this.isRecreateInFlight = true;
    if (preserveData && !force) {
      try { if ((await this.deps.ops.probeGateway()).isBusy) throw new SandDevBoxRecreateError(actionFailureMessage(action, "an agent is working")); }
      catch (error) { this.isRecreateInFlight = false; throw error; }
    }
    const operationId = { value: (this.deps.uuid ?? randomUUID)() };
    if (preserveData) {
      this.runDetached(operationId, action, async (emit) => {
        emit("backing-up", "flushing the durable box store"); if (await this.deps.ops.flushBoxStore() !== "flushed") this.deps.log("store flush unavailable; the mounted sand-data tree is the carrier.");
        emit("creating", "refreshing the box image"); await this.ensureImage();
        emit("creating", "swapping in a fresh container"); await this.deps.ops.removeContainer(); await this.deps.ops.recreateContainer();
        emit("moving", "verifying the preserved data tree and the new gateway");
        if (!await this.deps.ops.hasSandData()) throw new SandDevBoxRecreateError("sand-data is missing after the recreate");
        if (!(await this.deps.ops.probeGateway()).isReachable) throw new SandDevBoxRecreateError("the recreated container's gateway did not come up");
      });
    } else {
      this.runDetached(operationId, action, async (emit) => {
        await this.ensureImage(); emit("cleaning-up", "tearing down the old container"); await this.deps.ops.removeContainer();
        emit("wiping", "wiping sand-data and the durable box store"); await this.deps.ops.wipeSandData(); await this.deps.ops.clearStore();
        emit("creating", "booting a fresh container"); await this.deps.ops.recreateContainer();
      });
    }
    return { status: "started", operationId };
  }

  async forceRecreate(): Promise<{ status: "started"; operationId: OperationId } | { status: "rejected"; reason: string }> {
    if (this.isRecreateInFlight) return { status: "rejected", reason: actionFailureMessage("reset", "another recreate is in flight") };
    this.isRecreateInFlight = true;
    const operationId = { value: (this.deps.uuid ?? randomUUID)() };
    let storeEnabled: boolean;
    try { storeEnabled = await this.deps.ops.isStoreEnabled(); } catch (error) { this.isRecreateInFlight = false; throw error; }
    this.runDetached(operationId, "reset", async (emit) => {
      await this.ensureImage();
      if (await this.deps.ops.flushBoxStore() !== "flushed") this.deps.log("pre-reset flush unavailable (box unreachable); restoring from the last snapshot.");
      emit("cleaning-up", "tearing down the old container and its live data"); await this.deps.ops.removeContainer(); await this.deps.ops.wipeSandData();
      emit("creating", "booting a fresh container from the durable store"); await this.deps.ops.recreateContainer({ hydrateFromStore: storeEnabled });
      if (storeEnabled) { const outcome = await this.deps.ops.readCopyInOutcome(); if (outcome !== "hydrated") throw new SandDevBoxRecreateError(`restore incomplete: boot copy-in outcome=${outcome ?? "unknown"}`); }
      else this.deps.log("box store disabled (SAND_DEV_BOX_NO_STORE); skipping the copy-in gate.");
    });
    return { status: "started", operationId };
  }

  private async ensureImage(): Promise<void> {
    if (this.deps.imageIsPullable || !await this.deps.ops.imageExists()) await this.deps.ops.pullImage((percent) => this.deps.emitPullProgress(percent));
  }
  private runDetached(operationId: OperationId, action: string, work: (emit: (phase: MigrationPhase, detail: string) => void) => Promise<void>): void {
    this.isRecreateInFlight = true;
    const emit = (phase: MigrationPhase, detail: string): void => { this.deps.log(`${action} ${operationId.value.slice(0, 8)}: ${phase} — ${detail}`); this.deps.emitMigration({ operationId, phase, detail }); };
    void (async () => { try { await work(emit); emit("done", ""); } catch (error) { emit("failed", error instanceof Error ? error.message : String(error)); } finally { this.isRecreateInFlight = false; } })();
  }
}

export function actionFailureMessage(action: string, reason: string): string { return `Couldn't ${action} the computer (${reason}). It is unchanged.`; }
export interface RemoteHostConnector<TCredential = unknown> {
  connect(): Promise<BoxConnectionInfo>;
  issueLocalExecDaemonCredential?: () => Promise<TCredential | undefined>;
  recreate?: (args: { preserveData: boolean; force?: boolean }) => Promise<RecreateResult>;
  forceRecreate?: () => Promise<RecreateResult>;
}
export function wrapRemoteHostConnectorWithDevBoxPlane<TCredential>(base: RemoteHostConnector<TCredential>, deps: Omit<DevBoxRecreatePlaneDependencies, "ops" | "imageIsPullable"> & { readonly env?: NodeJS.ProcessEnv; readonly isPackaged: boolean; readonly ops?: DevBoxRecreateOps }): RemoteHostConnector<TCredential> {
  const config = resolveDevBoxControlPlaneConfig(deps.env ?? process.env, { isPackaged: deps.isPackaged });
  if (config == null || base.recreate != null || base.forceRecreate != null) return base;
  const plane = new DevBoxRecreatePlane({ ...deps, ops: deps.ops ?? createDevBoxRecreateOps({ config, log: deps.log }), imageIsPullable: config.imageIsPullable });
  deps.log(`dev box recreate/reset control plane armed (container ${config.containerName}, image ${config.image}).`);
  return {
    connect: () => base.connect(),
    ...(base.issueLocalExecDaemonCredential == null ? {} : { issueLocalExecDaemonCredential: base.issueLocalExecDaemonCredential.bind(base) }),
    recreate: (args) => plane.recreate(args),
    forceRecreate: () => plane.forceRecreate(),
  };
}
