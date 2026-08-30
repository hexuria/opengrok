import type { SpawnOptions } from "node:child_process";

import { scrubSocketEnvVars } from "../env-filter.js";
import { withConfiguredRipgrepEnv } from "../ripgrep.js";
import { isNetworkEnabledByPolicy, type NetworkPolicy } from "./network-policy-utils.js";

export type HelperNetworkPolicy = {
  readonly version: 1;
  readonly default?: "allow" | "deny";
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly logging?: unknown;
  readonly [key: string]: unknown;
};

export type HelperSandboxPolicy = {
  readonly type: "workspace_readwrite" | "workspace_readonly" | "insecure_none";
  readonly networkPolicy?: HelperNetworkPolicy;
  readonly networkPolicyStrict?: boolean;
};

export type HelperShellOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: boolean | string;
  readonly stdio?: SpawnOptions["stdio"];
};

export type HelperPolicyEnvelope = {
  readonly sandbox: unknown;
  readonly networkPolicy?: HelperNetworkPolicy;
  readonly networkPolicyStrict?: false;
};

export function resolveNetworkPolicyForFile(sandboxPolicy: HelperSandboxPolicy): HelperNetworkPolicy | undefined {
  if (sandboxPolicy.type === "insecure_none") {
    return undefined;
  }
  const policy = sandboxPolicy.networkPolicy;
  if (policy === undefined) {
    return undefined;
  }
  const effectivePolicy: NetworkPolicy = policy.default === undefined
    ? { version: policy.version, default: "deny", ...(policy.allow === undefined ? {} : { allow: policy.allow }) }
    : { version: policy.version, default: policy.default, ...(policy.allow === undefined ? {} : { allow: policy.allow }) };
  if (!isNetworkEnabledByPolicy(effectivePolicy)) {
    return undefined;
  }
  const hasDenyList = policy.deny !== undefined && policy.deny.length > 0;
  if (policy.default === "allow" && !hasDenyList) {
    return undefined;
  }
  const resolvedPolicy = { ...policy };
  resolvedPolicy.version = 1;
  return resolvedPolicy;
}

export function projectSandboxCommand(
  command: string,
  args: readonly string[] = [],
  shell: boolean | string | undefined,
): { readonly command: string; readonly args: readonly string[] } {
  if (!shell) {
    return { command, args };
  }
  if (process.platform === "win32") {
    const shellPath = typeof shell === "string" ? shell : "cmd.exe";
    return { command: shellPath, args: ["/c", `${command} ${args.join(" ")}`] };
  }
  const shellPath = typeof shell === "string" ? shell : "/bin/sh";
  return { command: shellPath, args: ["-c", `${command} ${args.join(" ")}`] };
}

export function buildSandboxPolicyEnvelope(
  sandbox: unknown,
  sandboxPolicy: HelperSandboxPolicy,
): HelperPolicyEnvelope {
  const envelope: { sandbox: unknown; networkPolicy?: HelperNetworkPolicy; networkPolicyStrict?: false } = { sandbox };
  const resolvedNetworkPolicy = resolveNetworkPolicyForFile(sandboxPolicy);
  if (resolvedNetworkPolicy !== undefined) {
    envelope.networkPolicy = resolvedNetworkPolicy;
  }
  if (sandboxPolicy.networkPolicyStrict === false) {
    envelope.networkPolicyStrict = false;
  }
  return envelope;
}

export function buildSandboxArgv(
  policyFilePath: string,
  command: string,
  args: readonly string[],
): readonly string[] {
  return ["--policy", policyFilePath, "--", command, ...args];
}

export function buildSandboxChildEnvironment(optionsEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const baseEnv = process.platform === "linux" ? scrubSocketEnvVars(process.env) : process.env;
  const environment = process.platform === "linux" && optionsEnv !== undefined
    ? scrubSocketEnvVars(optionsEnv)
    : optionsEnv;
  const mergedEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...environment,
    CURSOR_SANDBOX: "native",
  };
  if (process.platform === "linux") {
    Object.assign(mergedEnv, withConfiguredRipgrepEnv(mergedEnv));
  }
  return mergedEnv;
}

export function buildSandboxSpawnOptions(
  options: HelperShellOptions,
  executionCwd: string,
): Pick<SpawnOptions, "cwd" | "env" | "stdio"> {
  return {
    cwd: options.cwd || executionCwd,
    env: buildSandboxChildEnvironment(options.env),
    stdio: options.stdio || ["pipe", "pipe", "pipe"],
  };
}
