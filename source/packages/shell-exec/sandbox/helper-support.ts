import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";

import { createContext, type Context } from "../../context/index.js";
import { createLogger } from "../../context/logger.js";
import { filterElectronEnv, scrubSocketEnvVars } from "../env-filter.js";
import { withConfiguredRipgrepEnv } from "../ripgrep.js";
import { buildNativeSandboxPolicy, type NativeSandboxPolicyInput } from "./native-policy.js";
import { resolveNetworkPolicyForFile, type HelperNetworkPolicy } from "./helper-protocol.js";
import { registerSandboxMetadata } from "./macos/seatbelt.js";
import { writeSandboxPolicyFile } from "./policy-file.js";
import { withSandboxPolicyDirectoryReadonly } from "./policy-readonly.js";

type PreflightInvocation = {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
};

type PreflightFailure = {
  message?: string;
  status?: number;
  stderrText?: string;
};

export type SandboxHelperPolicy = Omit<NativeSandboxPolicyInput, "networkPolicy"> & {
  readonly networkPolicy?: HelperNetworkPolicy;
  readonly networkPolicyStrict?: boolean;
  readonly sandboxWorkspaceRoot?: string;
  readonly enableSharedBuildCache?: boolean;
};

const logger = createLogger("shell-exec:sandbox");
const isMacOS = process.platform === "darwin";
const isLinux = process.platform === "linux";
const PREFLIGHT_PROBE_TIMEOUT_MS = 15_000;

// This binding is intentionally private and uninitialized. The shipped artifact
// receives no configured helper path in this reconstruction; no fallback path is
// inferred here.
let configuredSandboxBinaryPath: string | undefined;
let binaryAvailable: boolean | null = null;
let binaryCheckError: unknown = null;
let lastSandboxFailureReason: string | null = null;
let cachedSandboxHelperSupported: boolean | null = null;

function getSandboxBinary(): string | undefined {
  return configuredSandboxBinaryPath;
}

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return undefined;
}

function checkBinaryAvailable(ctx: Context): boolean {
  if (binaryAvailable !== null) {
    return binaryAvailable;
  }
  try {
    const binaryPath = getSandboxBinary();
    logger.info(ctx, `[checkBinaryAvailable] Resolved binary path: ${binaryPath}`);
    if (!binaryPath) {
      binaryCheckError = new Error("Sandbox binary path was not configured");
      binaryAvailable = false;
      logger.info(ctx, "[checkBinaryAvailable] Binary path not set, returning false");
      return false;
    }
    binaryAvailable = existsSync(binaryPath);
    if (!binaryAvailable) {
      binaryCheckError = new Error(`Sandbox binary not found at ${binaryPath}`);
      logger.info(ctx, `[checkBinaryAvailable] Binary not found at: ${binaryPath}`);
    } else {
      logger.info(ctx, `[checkBinaryAvailable] Binary path exists: ${binaryAvailable}`);
    }
    return binaryAvailable;
  } catch (error) {
    binaryCheckError = error;
    binaryAvailable = false;
    logger.info(ctx, `[checkBinaryAvailable] Exception checking binary: ${error}`);
    return false;
  }
}

function applyConfiguredRipgrepToSandboxEnv(env: NodeJS.ProcessEnv): void {
  if (process.platform !== "linux") {
    return;
  }
  Object.assign(env, withConfiguredRipgrepEnv(env));
}

function buildPreflightInvocation(ctx: Context, cwd: string): PreflightInvocation {
  const preflightPolicy: NativeSandboxPolicyInput = { type: "workspace_readwrite" };
  const unifiedPolicy = {
    sandbox: buildNativeSandboxPolicy(withSandboxPolicyDirectoryReadonly(preflightPolicy), cwd),
  };
  const binaryPath = String(getSandboxBinary());
  logger.info(ctx, `[sandboxPreflight] Running preflight with binary: ${binaryPath}`);
  logger.info(ctx, `[sandboxPreflight] CWD: ${cwd}`);
  const env = { ...process.env };
  applyConfiguredRipgrepToSandboxEnv(env);
  const policyFilePath = writeSandboxPolicyFile(JSON.stringify(unifiedPolicy));
  return {
    binaryPath,
    args: ["--policy", policyFilePath, "--preflight-only", "--", "/bin/true"],
    env,
  };
}

function recordPreflightFailure(ctx: Context, failure: PreflightFailure): false {
  const { message, status, stderrText } = failure;
  logger.error(ctx, `[sandboxPreflight] Preflight failed: ${message}`, failure);
  logger.error(ctx, `[sandboxPreflight] Exit status: ${status}`, failure);
  if (stderrText) {
    logger.error(ctx, `[sandboxPreflight] Stderr: ${stderrText}`, failure);
  }
  if (status === 2) {
    lastSandboxFailureReason = `Linux preflight failed with exit code 2 (unsupported kernel features). stderr: ${stderrText || "none"}`;
  } else {
    lastSandboxFailureReason = `Linux preflight failed: ${message || "unknown error"}. Exit status: ${status}. stderr: ${stderrText || "none"}`;
  }
  cachedSandboxHelperSupported = false;
  return false;
}

export function isSandboxHelperSupported(ctx?: Context): boolean {
  if (cachedSandboxHelperSupported !== null) {
    return cachedSandboxHelperSupported;
  }
  const effectiveCtx = ctx ?? createContext();
  logger.info(effectiveCtx, "[isSandboxHelperSupported] Starting sandbox support check...");
  if (!checkBinaryAvailable(effectiveCtx)) {
    const reason = getErrorMessage(binaryCheckError) ?? "Binary check failed";
    lastSandboxFailureReason = reason;
    logger.info(effectiveCtx, `[isSandboxHelperSupported] Binary not available, returning false. Reason: ${reason}`);
    cachedSandboxHelperSupported = false;
    return cachedSandboxHelperSupported;
  }
  if (process.platform === "win32") {
    lastSandboxFailureReason = "Windows sandbox helper only provides network proxy, not filesystem isolation";
    logger.info(effectiveCtx, "[isSandboxHelperSupported] win32: returning false (proxy-only, no filesystem sandbox)");
    cachedSandboxHelperSupported = false;
    return cachedSandboxHelperSupported;
  }
  if (isMacOS) {
    lastSandboxFailureReason = null;
    logger.info(effectiveCtx, `[isSandboxHelperSupported] ${process.platform} platform, binary available, sandbox supported!`);
    cachedSandboxHelperSupported = true;
    return cachedSandboxHelperSupported;
  }
  const { binaryPath, args, env } = buildPreflightInvocation(effectiveCtx, process.cwd());
  try {
    const preflightStart = Date.now();
    execFileSync(binaryPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: PREFLIGHT_PROBE_TIMEOUT_MS,
      env,
      shell: false,
    });
    const preflightMs = Date.now() - preflightStart;
    lastSandboxFailureReason = null;
    logger.info(effectiveCtx, `[isSandboxHelperSupported] Preflight succeeded in ${preflightMs}ms, sandbox supported!`);
    cachedSandboxHelperSupported = true;
    return cachedSandboxHelperSupported;
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : undefined;
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
    const stderrValue = typeof error === "object" && error !== null && "stderr" in error ? error.stderr : undefined;
    const stderrText = stderrValue !== undefined && stderrValue !== null && typeof stderrValue === "object" && "toString" in stderrValue && typeof stderrValue.toString === "function"
      ? stderrValue.toString()
      : "";
    const failure: PreflightFailure = { stderrText };
    if (message !== undefined) failure.message = message;
    if (status !== undefined) failure.status = status;
    return recordPreflightFailure(effectiveCtx, failure);
  }
}

function toNativeSandboxPolicyInput(policy: SandboxHelperPolicy): NativeSandboxPolicyInput {
  const networkPolicy = policy.networkPolicy;
  return {
    type: policy.type,
    ...(policy.readBoundary === undefined ? {} : { readBoundary: policy.readBoundary }),
    ...(policy.additionalReadPaths === undefined ? {} : { additionalReadPaths: policy.additionalReadPaths }),
    ...(policy.additionalReadwritePaths === undefined ? {} : { additionalReadwritePaths: policy.additionalReadwritePaths }),
    ...(policy.additionalReadonlyPaths === undefined ? {} : { additionalReadonlyPaths: policy.additionalReadonlyPaths }),
    ...(policy.writeProtectionMapping === undefined ? {} : { writeProtectionMapping: policy.writeProtectionMapping }),
    ...(policy.ignoreMapping === undefined ? {} : { ignoreMapping: policy.ignoreMapping }),
    ...(networkPolicy === undefined ? {} : {
      networkPolicy: {
        version: 1,
        default: networkPolicy.default ?? "deny",
        ...(networkPolicy.allow === undefined ? {} : { allow: networkPolicy.allow }),
        ...(networkPolicy.deny === undefined ? {} : { deny: networkPolicy.deny }),
      },
    }),
    ...(policy.disableTmpWrite === undefined ? {} : { disableTmpWrite: policy.disableTmpWrite }),
  };
}

export function spawnWithSandboxHelper(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  sandboxPolicy: SandboxHelperPolicy,
): ChildProcess {
  const ctx = createContext();
  options.env = filterElectronEnv(options.env);
  if (!checkBinaryAvailable(ctx)) {
    throw new Error(`Sandbox binary not available: ${getErrorMessage(binaryCheckError) ?? "binary not configured"}. Please build the binary or use 'insecure_none' policy.`);
  }
  if (sandboxPolicy.type === "insecure_none") {
    return spawn(command, args, options);
  }
  if (sandboxPolicy.type === "workspace_readwrite" || sandboxPolicy.type === "workspace_readonly") {
    return spawnWithSandboxHelperPolicy(command, args, options, sandboxPolicy);
  }
  throw new Error(`Unsupported sandbox policy: ${String(sandboxPolicy)}`);
}

export function spawnWithSandboxHelperPolicy(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  sandboxPolicy: SandboxHelperPolicy,
): ChildProcess {
  if (sandboxPolicy.type !== "workspace_readwrite" && sandboxPolicy.type !== "workspace_readonly") {
    throw new Error("Expected workspace_readwrite or workspace_readonly policy");
  }
  const executionCwd = String(options.cwd ?? process.cwd());
  const cwd = sandboxPolicy.sandboxWorkspaceRoot ?? executionCwd;
  let actualCommand = command;
  let actualArgs = args;
  if (options.shell) {
    if (process.platform === "win32") {
      const shellPath = typeof options.shell === "string" ? options.shell : "cmd.exe";
      actualCommand = shellPath;
      actualArgs = ["/c", `${command} ${args.join(" ")}`];
    } else {
      const shellPath = typeof options.shell === "string" ? options.shell : "/bin/sh";
      actualCommand = shellPath;
      actualArgs = ["-c", `${command} ${args.join(" ")}`];
    }
  }
  const sandbox = buildNativeSandboxPolicy(
    withSandboxPolicyDirectoryReadonly(toNativeSandboxPolicyInput(sandboxPolicy)),
    cwd,
  );
  const resolvedNetworkPolicy = resolveNetworkPolicyForFile(sandboxPolicy);
  const unifiedPolicy: { sandbox: typeof sandbox; networkPolicy?: HelperNetworkPolicy; networkPolicyStrict?: false } = { sandbox };
  if (resolvedNetworkPolicy !== undefined) {
    unifiedPolicy.networkPolicy = resolvedNetworkPolicy;
  }
  if (sandboxPolicy.networkPolicyStrict === false) {
    unifiedPolicy.networkPolicyStrict = false;
  }
  const policyFilePath = writeSandboxPolicyFile(JSON.stringify(unifiedPolicy));
  const sandboxArgs = ["--policy", policyFilePath, "--", actualCommand, ...actualArgs];
  const baseEnv = process.platform === "linux" ? scrubSocketEnvVars(process.env) : process.env;
  const optionsEnv = process.platform === "linux" && options.env !== undefined ? scrubSocketEnvVars(options.env) : options.env;
  const mergedEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...optionsEnv,
    CURSOR_SANDBOX: "native",
  };
  applyConfiguredRipgrepToSandboxEnv(mergedEnv);
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd || executionCwd,
    env: mergedEnv,
    stdio: options.stdio || ["pipe", "pipe", "pipe"],
  };
  try {
    const startTime = new Date();
    const child = spawn(String(getSandboxBinary()), sandboxArgs, spawnOptions);
    if (isMacOS && child.pid) {
      registerSandboxMetadata(child, { startTime, pid: child.pid });
    }
    return child;
  } catch (error) {
    throw new Error(`Failed to spawn sandboxed process: ${error}`);
  }
}

export function getLastSandboxFailureReason(): string | null {
  return lastSandboxFailureReason;
}
