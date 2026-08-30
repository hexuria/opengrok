import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getRipgrepBinaryPath } from "../ripgrep.js";
import { isNetworkEnabledByPolicy, type NetworkPolicy } from "./network-policy-utils.js";
import { convertPathsToIgnoreMapping, getHardcodedAllowedReadPaths } from "./hardcoded-policy.js";

export type NativeSandboxPolicyType = "workspace_readwrite" | "workspace_readonly" | "insecure_none";
export type NativeReadBoundary = "system" | "workspace";
export type NativeIgnoreMapping = Record<string, readonly string[]>;

export interface NativeSandboxPolicyInput {
  readonly type: NativeSandboxPolicyType;
  readonly readBoundary?: NativeReadBoundary;
  readonly additionalReadPaths?: readonly string[];
  readonly additionalReadwritePaths?: readonly string[];
  readonly additionalReadonlyPaths?: readonly string[];
  readonly writeProtectionMapping?: NativeIgnoreMapping;
  readonly ignoreMapping?: NativeIgnoreMapping;
  readonly networkPolicy?: NetworkPolicy;
  readonly disableTmpWrite?: boolean;
}

export interface NativeSandboxPolicy {
  readonly type: NativeSandboxPolicyType;
  readonly cwd: string;
  readonly readBoundary: NativeReadBoundary;
  readonly hardcodedReadPaths: readonly string[];
  readonly additionalReadonlyPaths: NativeIgnoreMapping | undefined;
  readonly networkAccess: boolean;
  readonly ignoreMapping: NativeIgnoreMapping | undefined;
  readonly additionalReadwritePaths?: readonly string[];
  readonly disableTmpWrite?: boolean;
}

function isGitBackedSync(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const dotGit = path.join(current, ".git");
      if (existsSync(dotGit)) {
        return true;
      }
    } catch {
      // Probe failures are treated as not git-backed.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function uriToFsPath(uri: string): string {
  let result = uri.replace(/^file:\/\//, "");
  result = decodeURIComponent(result);
  if (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

function tryRealpath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function normalizeIgnoreMapping(ignoreMapping: NativeIgnoreMapping): NativeIgnoreMapping {
  const result: Record<string, readonly string[]> = {};
  for (const [rawPath, patterns] of Object.entries(ignoreMapping)) {
    const fsPath = rawPath.startsWith("file://") ? uriToFsPath(rawPath) : rawPath;
    result[fsPath] = patterns;
    const canonicalPath = tryRealpath(fsPath);
    if (canonicalPath !== fsPath) {
      result[canonicalPath] = patterns;
    }
  }
  return result;
}

function buildIgnoreMapping(ignoreMapping: NativeIgnoreMapping): NativeIgnoreMapping {
  return normalizeIgnoreMapping(ignoreMapping);
}

function normalizeAdditionalReadPathRoots(paths: readonly string[]): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    let entry = raw.trim();
    if (!entry) {
      continue;
    }
    if (entry === "~") {
      entry = os.homedir();
    } else if (entry.startsWith("~/") || entry.startsWith("~\\")) {
      entry = path.join(os.homedir(), entry.slice(2));
    }
    entry = entry.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
    entry = entry.replace(/\\\*\*$/, "").replace(/\\\*$/, "");
    const base = path.basename(entry);
    if (base.includes("*") || base.includes("?")) {
      entry = path.dirname(entry);
    }
    if (!entry || entry === ".") {
      continue;
    }
    const normalized = path.normalize(entry);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    roots.push(normalized);
  }
  return roots;
}

function buildReadOnlyJson(
  additionalReadonlyPaths: readonly string[] | undefined,
  writeProtectionMapping: NativeIgnoreMapping | undefined,
  cwd: string,
): NativeIgnoreMapping | undefined {
  const fromPaths = additionalReadonlyPaths !== undefined && additionalReadonlyPaths.length > 0
    ? convertPathsToIgnoreMapping(...additionalReadonlyPaths)
    : {};
  const cwdIsGitBacked = isGitBackedSync(cwd);
  const fromWorkspace = process.platform !== "linux" || cwdIsGitBacked
    ? writeProtectionMapping ?? {}
    : {};
  const merged: Record<string, readonly string[]> = { ...fromPaths };
  for (const [dir, patterns] of Object.entries(fromWorkspace)) {
    if (merged[dir] !== undefined) {
      merged[dir] = [...merged[dir], ...patterns];
    } else {
      merged[dir] = patterns;
    }
  }
  if (Object.keys(merged).length === 0) {
    return undefined;
  }
  return normalizeIgnoreMapping(merged);
}

function resolveHardcodedAllowedReadPaths(platform = process.platform): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  const bundledPaths: Record<string, string> = {};
  try {
    bundledPaths.ripgrep = getRipgrepBinaryPath();
  } catch {
    // Ripgrep is optional for the trusted-read allowlist.
  }
  const allowed = platform === "linux" || platform === "darwin"
    ? getHardcodedAllowedReadPaths(platform, os.homedir(), bundledPaths)
    : [];
  for (const entry of allowed) {
    let pathToUse = entry;
    try {
      if (existsSync(entry)) {
        pathToUse = realpathSync(entry);
      }
    } catch {
      // Individual trusted paths are best-effort.
    }
    if (seen.has(pathToUse)) {
      continue;
    }
    seen.add(pathToUse);
    resolved.push(pathToUse);
  }
  return resolved;
}

export function buildNativeSandboxPolicy(
  sandboxPolicy: NativeSandboxPolicyInput,
  cwd: string,
): NativeSandboxPolicy {
  let ignoreMapping: NativeIgnoreMapping | undefined;
  if (sandboxPolicy.ignoreMapping) {
    ignoreMapping = buildIgnoreMapping(sandboxPolicy.ignoreMapping);
  }
  const additionalReadonlyPaths = buildReadOnlyJson(
    sandboxPolicy.additionalReadonlyPaths,
    sandboxPolicy.writeProtectionMapping,
    cwd,
  );
  const readBoundary = sandboxPolicy.readBoundary ?? "system";
  const trustedReadPaths = resolveHardcodedAllowedReadPaths();
  const allowlistRoots = readBoundary === "workspace"
    ? normalizeAdditionalReadPathRoots(sandboxPolicy.additionalReadPaths ?? [])
    : [];
  const hardcodedReadPaths = [...trustedReadPaths];
  const seen = new Set(trustedReadPaths);
  for (const root of allowlistRoots) {
    if (seen.has(root)) {
      continue;
    }
    seen.add(root);
    hardcodedReadPaths.push(root);
  }
  const common = {
    cwd,
    readBoundary,
    hardcodedReadPaths,
    additionalReadonlyPaths,
    networkAccess: isNetworkEnabledByPolicy(sandboxPolicy.networkPolicy),
    ignoreMapping,
  };
  if (sandboxPolicy.type === "workspace_readonly") {
    return {
      type: sandboxPolicy.type,
      ...common,
    };
  }
  return {
    type: sandboxPolicy.type,
    ...common,
    additionalReadwritePaths: sandboxPolicy.additionalReadwritePaths || [],
    disableTmpWrite: sandboxPolicy.disableTmpWrite || false,
  };
}
