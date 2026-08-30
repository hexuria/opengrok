import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { spawnPromise } from "../../utils/spawn-promise.js";
import {
  getGitWriteProtectionMapping,
  getHardcodedSandboxPolicy,
  getWorktreeWriteProtectionMapping,
} from "./hardcoded-policy.js";
import { getEffectiveNetworkPolicy } from "./network-policy-utils.js";

type PolicyType = "workspace_readwrite" | "workspace_readonly" | "insecure_none";
type ReadBoundary = "workspace" | "system";
type IgnoreMapping = Record<string, readonly string[]>;
type NetworkPolicy = {
  version: 1;
  default?: "allow" | "deny" | undefined;
  allow?: readonly string[] | undefined;
  deny?: readonly string[] | undefined;
  logging?: unknown;
};
type PolicyRule = {
  type: PolicyType;
  disableTmpWrite?: boolean | undefined;
  networkPolicyStrict?: boolean | undefined;
  readBoundary?: ReadBoundary | undefined;
  additionalReadPaths?: readonly string[] | undefined;
  additionalReadwritePaths?: readonly string[] | undefined;
  additionalReadonlyPaths?: readonly string[] | undefined;
  networkPolicy?: NetworkPolicy | undefined;
  debugOutputDir?: string | undefined;
  captureDenies?: boolean | undefined;
  enableSharedBuildCache?: boolean | undefined;
  ignoreMapping?: IgnoreMapping | undefined;
  writeProtectionMapping?: IgnoreMapping | undefined;
  allowlistEscalated?: boolean | undefined;
};
type PolicySources = {
  perUser?: PolicyRule | undefined;
  perRepo?: PolicyRule | undefined;
  teamAdmin?: PolicyRule | undefined;
};
type MergeOptions = {
  workspaceDir?: string | undefined;
  gitDirParent?: string | undefined;
  debug?: boolean | undefined;
};
type ResolvedPolicy = { type: PolicyType; [key: string]: unknown };
type ResolveResult = {
  policy: ResolvedPolicy;
  debug?: { fieldSources: Record<string, string> } | undefined;
};

export function getSandboxPolicyType(policy: PolicySources): PolicyType {
  return policy.teamAdmin?.type ?? policy.perRepo?.type ?? policy.perUser?.type ?? "insecure_none";
}

function mergeRestrictiveBoolean(...values: Array<boolean | undefined>): boolean {
  return values.some((value) => value === true);
}

function mergePathsIntersection(...sources: Array<readonly string[] | undefined>): string[] {
  const definedSources = sources.filter((source): source is readonly string[] => source !== undefined);
  if (definedSources.length === 0) {
    return [];
  }
  if (definedSources.some((source) => source.length === 0)) {
    return [];
  }
  if (definedSources.length === 1) {
    return deduplicatePaths(definedSources[0]!).map(normalizePath);
  }
  let result = new Set(definedSources[0]!.map(normalizePath));
  for (let index = 1; index < definedSources.length; index += 1) {
    const sourceSet = new Set(definedSources[index]!.map(normalizePath));
    result = new Set([...result].filter((path) => sourceSet.has(path)));
  }
  return [...result];
}

function mergePathsUnion(...sources: Array<readonly string[] | undefined>): string[] {
  const allPaths = new Set<string>();
  for (const source of sources) {
    if (source) {
      for (const path of source) {
        allPaths.add(normalizePath(path));
      }
    }
  }
  return [...allPaths];
}

function rankedPolicyField<Value extends string>({ defaultValue, rank }: { defaultValue: Value; rank: Record<Value, number> }) {
  return {
    defaultValue,
    merge: (...sources: Array<Value | undefined>): Value => {
      const definedSources = sources.filter((source): source is Value => source !== undefined);
      if (definedSources.length === 0) {
        return defaultValue;
      }
      return definedSources.reduce((strictest, source) => rank[source] < rank[strictest] ? source : strictest);
    },
  };
}

function intersectingPathPolicyField() {
  return {
    defaultValue: [] as string[],
    merge: (...sources: Array<readonly string[] | undefined>): string[] => mergePathsIntersection(...sources),
  };
}

const readBoundaryPolicyField = rankedPolicyField<ReadBoundary>({
  defaultValue: "system",
  rank: {
    workspace: 0,
    system: 1,
  },
});

const additionalReadPathsPolicyField = intersectingPathPolicyField();

function mergeReadBoundary(...sources: Array<ReadBoundary | undefined>): ReadBoundary {
  return readBoundaryPolicyField.merge(...sources);
}

function mergeAdditionalReadPaths(...sources: Array<readonly string[] | undefined>): string[] {
  return additionalReadPathsPolicyField.merge(...sources);
}

function workspaceReadPathsSource(readBoundary: ReadBoundary | undefined, additionalReadPaths: readonly string[] | undefined): readonly string[] | undefined {
  if (readBoundary !== "workspace" || additionalReadPaths === undefined) {
    return undefined;
  }
  return additionalReadPaths;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === "") {
    return "/";
  }
  if (/^[a-zA-Z]:$/.test(normalized)) {
    return `${normalized}/`;
  }
  return normalized;
}

function deduplicatePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = normalizePath(path);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(path);
    }
  }
  return result;
}

function mergeNetworkPolicies(...sources: Array<NetworkPolicy | undefined>): NetworkPolicy | undefined {
  const definedSources = sources.filter((source): source is NetworkPolicy => source !== undefined);
  if (definedSources.length === 0) {
    return undefined;
  }
  let mergedDefault: "allow" | "deny" | undefined;
  for (const source of definedSources) {
    if (source.default === "deny") {
      mergedDefault = "deny";
      break;
    } else if (source.default === "allow" && mergedDefault === undefined) {
      mergedDefault = "allow";
    }
  }
  const mergedDeny = new Set<string>();
  for (const source of definedSources) {
    if (source.deny) {
      for (const pattern of source.deny) {
        mergedDeny.add(pattern);
      }
    }
  }
  const mergedAllowSet = new Set<string>();
  for (const source of definedSources) {
    if (source.allow) {
      for (const pattern of source.allow) {
        mergedAllowSet.add(pattern);
      }
    }
  }
  const mergedAllow = mergedAllowSet.size > 0 ? [...mergedAllowSet] : undefined;
  let mergedLogging: unknown;
  for (let index = definedSources.length - 1; index >= 0; index -= 1) {
    if (definedSources[index]!.logging !== undefined) {
      mergedLogging = definedSources[index]!.logging;
      break;
    }
  }
  const merged: NetworkPolicy = {
    version: 1,
  };
  if (mergedDefault !== undefined) {
    merged.default = mergedDefault;
  }
  if (mergedAllow !== undefined) {
    merged.allow = mergedAllow;
  }
  if (mergedDeny.size > 0) {
    merged.deny = [...mergedDeny];
  }
  if (mergedLogging !== undefined) {
    merged.logging = mergedLogging;
  }
  if (merged.default === undefined && (merged.allow === undefined || merged.allow.length === 0) && (merged.deny === undefined || merged.deny.length === 0) && merged.logging === undefined) {
    return undefined;
  }
  return merged;
}

function mergeIgnoreMappings(...sources: Array<IgnoreMapping | undefined>): Record<string, string[]> | undefined {
  const definedSources = sources.filter((source): source is IgnoreMapping => source !== undefined);
  if (definedSources.length === 0) {
    return undefined;
  }
  const merged: Record<string, string[]> = {};
  for (const source of definedSources) {
    for (const [path, patterns] of Object.entries(source)) {
      const existing = merged[path];
      if (existing) {
        const patternSet = new Set(existing);
        for (const pattern of patterns) {
          if (patternSet.has(pattern)) {
            patternSet.delete(pattern);
          }
          patternSet.add(pattern);
        }
        merged[path] = [...patternSet];
      } else {
        merged[path] = [...patterns];
      }
    }
  }
  if (Object.keys(merged).length === 0) {
    return undefined;
  }
  return merged;
}

function takeHighestPriorityDefined<Value>(...sources: Array<Value | undefined>): Value | undefined {
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    if (sources[index] !== undefined) {
      return sources[index];
    }
  }
  return undefined;
}

export async function resolveSandboxPolicyForWorkspace(workspaceDir: string, sources: PolicySources | undefined): Promise<ResolveResult> {
  if (!sources) {
    return { policy: { type: "insecure_none" } };
  }
  const dotGitStat = await stat(join(workspaceDir, ".git")).then((value) => value, () => null);
  const isWorktree = dotGitStat?.isFile() ?? false;
  const isGitRepo = dotGitStat !== null;
  if (getSandboxPolicyType(sources) === "workspace_readwrite") {
    let gitDirParent = workspaceDir;
    if (isWorktree) {
      const commonDir = await spawnPromise("git", ["rev-parse", "--git-common-dir"], { cwd: workspaceDir }).then(
        (value) => resolve(workspaceDir, value.trim()),
        () => null,
      );
      if (commonDir) {
        gitDirParent = dirname(commonDir);
        const perRepo = sources.perRepo;
        const ignoreMapping = perRepo?.ignoreMapping;
        sources = {
          ...sources,
          perRepo: {
            ...perRepo,
            type: "workspace_readwrite",
            additionalReadwritePaths: [
              ...(perRepo?.additionalReadwritePaths ?? []),
              commonDir,
            ],
            ignoreMapping,
            writeProtectionMapping: mergeIgnoreMappings(
              perRepo?.writeProtectionMapping,
              getWorktreeWriteProtectionMapping(workspaceDir),
            ),
          },
        };
      }
    }
    if (isGitRepo) {
      return mergeSandboxPolicies(sources, {
        workspaceDir,
        gitDirParent,
      });
    }
  }
  return mergeSandboxPolicies(sources, { workspaceDir });
}

function validateAndGetPolicyType(sources: PolicySources): PolicyType | undefined {
  const { perUser, perRepo, teamAdmin } = sources;
  const definedPolicies = [perUser, perRepo, teamAdmin].filter((policy): policy is PolicyRule => policy !== undefined);
  if (definedPolicies.length === 0) {
    return undefined;
  }
  const firstType = definedPolicies[0]!.type;
  for (const policy of definedPolicies) {
    if (policy.type !== firstType) {
      throw new Error(`Cannot merge policies of different types: found "${firstType}" and "${policy.type}". All policies must be of the same type (all workspace_readwrite, all workspace_readonly, or all insecure_none).`);
    }
  }
  return firstType;
}

function mergeSandboxPolicies(sources: PolicySources, options: MergeOptions): ResolveResult {
  const policyType = validateAndGetPolicyType(sources);
  if (policyType === undefined) {
    return mergeWorkspaceReadWritePolicies(sources, options);
  }
  switch (policyType) {
    case "workspace_readwrite":
      return mergeWorkspaceReadWritePolicies(sources, options);
    case "workspace_readonly":
      return mergeWorkspaceReadOnlyPolicies(sources, options);
    case "insecure_none":
      return mergeInsecureNonePolicies(sources, options);
    default: {
      const exhaustive: never = policyType;
      throw new Error(`Unknown policy type: ${exhaustive}`);
    }
  }
}

function mergeCommonWorkspaceFields(sources: PolicySources, options?: MergeOptions) {
  const debug = options?.debug;
  const { perUser, perRepo, teamAdmin } = sources;
  const workspaceDir = options?.workspaceDir ?? process.cwd();
  const hardcoded = getHardcodedSandboxPolicy(workspaceDir) as ReturnType<typeof getHardcodedSandboxPolicy> & {
    networkPolicy?: NetworkPolicy | undefined;
    ignoreMapping?: IgnoreMapping | undefined;
  };
  const fieldSources: Record<string, string> = {};
  const orderedSources = [perUser, perRepo, teamAdmin];
  const sourceNames = ["perUser", "perRepo", "teamAdmin", "hardcoded"];
  const recordSource = (field: string, sourceIndex: number): void => {
    if (debug) {
      fieldSources[field] = sourceNames[sourceIndex] ?? "unknown";
    }
  };
  const disableTmpWrite = mergeRestrictiveBoolean(perUser?.disableTmpWrite, perRepo?.disableTmpWrite, teamAdmin?.disableTmpWrite);
  for (let index = orderedSources.length - 1; index >= 0; index -= 1) {
    if (orderedSources[index]?.disableTmpWrite === true) {
      recordSource("disableTmpWrite", index);
      break;
    }
  }
  const networkPolicyStrict = mergeRestrictiveBoolean(perUser?.networkPolicyStrict, perRepo?.networkPolicyStrict, teamAdmin?.networkPolicyStrict, hardcoded.networkPolicyStrict);
  if (hardcoded.networkPolicyStrict) {
    recordSource("networkPolicyStrict", 3);
  }
  const readBoundary = mergeReadBoundary(perUser?.readBoundary, perRepo?.readBoundary, teamAdmin?.readBoundary);
  const additionalReadPaths = mergeAdditionalReadPaths(
    workspaceReadPathsSource(perUser?.readBoundary, perUser?.additionalReadPaths),
    workspaceReadPathsSource(perRepo?.readBoundary, perRepo?.additionalReadPaths),
    workspaceReadPathsSource(teamAdmin?.readBoundary, teamAdmin?.additionalReadPaths),
  );
  const mergedReadPaths = readBoundary === "workspace" ? additionalReadPaths : undefined;
  const additionalReadonlyPaths = mergePathsUnion(
    perUser?.additionalReadonlyPaths,
    perRepo?.additionalReadonlyPaths,
    teamAdmin?.additionalReadonlyPaths,
    hardcoded.additionalReadonlyPaths,
  );
  const mergedReadonlyPaths = additionalReadonlyPaths.length > 0 ? additionalReadonlyPaths : undefined;
  let mergedNetworkPolicy = mergeNetworkPolicies(perUser?.networkPolicy, perRepo?.networkPolicy, teamAdmin?.networkPolicy, hardcoded.networkPolicy);
  const teamAdminAllow = teamAdmin?.networkPolicy?.allow;
  if (teamAdminAllow !== undefined && teamAdminAllow.length > 0 && mergedNetworkPolicy !== undefined) {
    mergedNetworkPolicy = {
      ...mergedNetworkPolicy,
      allow: [...teamAdminAllow],
    };
    if (debug) {
      fieldSources["networkPolicy.allow"] = "teamAdmin (replace)";
    }
  }
  const networkPolicy = getEffectiveNetworkPolicy(mergedNetworkPolicy as Parameters<typeof getEffectiveNetworkPolicy>[0]);
  const debugOutputDir = takeHighestPriorityDefined(perUser?.debugOutputDir, perRepo?.debugOutputDir, teamAdmin?.debugOutputDir);
  const captureDenies = mergeRestrictiveBoolean(perUser?.captureDenies, perRepo?.captureDenies, teamAdmin?.captureDenies);
  const enableSharedBuildCache = takeHighestPriorityDefined(perUser?.enableSharedBuildCache, perRepo?.enableSharedBuildCache, teamAdmin?.enableSharedBuildCache);
  const ignoreMapping = mergeIgnoreMappings(perUser?.ignoreMapping, perRepo?.ignoreMapping, teamAdmin?.ignoreMapping, hardcoded.ignoreMapping);
  const gitDirParent = options?.gitDirParent ?? workspaceDir;
  const gitWriteProtection = getGitWriteProtectionMapping(gitDirParent);
  const writeProtectionMapping = mergeIgnoreMappings(
    perUser?.writeProtectionMapping,
    perRepo?.writeProtectionMapping,
    teamAdmin?.writeProtectionMapping,
    hardcoded.writeProtectionMapping,
    gitWriteProtection,
  );
  return {
    disableTmpWrite: disableTmpWrite || undefined,
    networkPolicyStrict,
    readBoundary,
    additionalReadPaths: mergedReadPaths,
    additionalReadonlyPaths: mergedReadonlyPaths,
    networkPolicy,
    debugOutputDir,
    captureDenies: captureDenies || undefined,
    enableSharedBuildCache,
    ignoreMapping,
    writeProtectionMapping,
    fieldSources,
  };
}

function cleanPolicy(policy: Record<string, unknown>, type: PolicyType): ResolvedPolicy {
  const clean = Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== undefined));
  clean.type = type;
  return clean as ResolvedPolicy;
}

function mergeWorkspaceReadWritePolicies(sources: PolicySources, options?: MergeOptions): ResolveResult {
  const { perUser, perRepo, teamAdmin } = sources;
  const debug = options?.debug;
  const common = mergeCommonWorkspaceFields(sources, options);
  const additionalReadwritePaths = mergePathsUnion(
    perUser?.additionalReadwritePaths,
    perRepo?.additionalReadwritePaths,
    teamAdmin?.additionalReadwritePaths,
  );
  const policy = {
    type: "workspace_readwrite",
    disableTmpWrite: common.disableTmpWrite,
    networkPolicyStrict: common.networkPolicyStrict,
    readBoundary: common.readBoundary,
    additionalReadPaths: common.additionalReadPaths,
    additionalReadwritePaths: additionalReadwritePaths.length > 0 ? additionalReadwritePaths : undefined,
    additionalReadonlyPaths: common.additionalReadonlyPaths,
    networkPolicy: common.networkPolicy,
    debugOutputDir: common.debugOutputDir,
    captureDenies: common.captureDenies,
    enableSharedBuildCache: common.enableSharedBuildCache,
    ignoreMapping: common.ignoreMapping,
    writeProtectionMapping: common.writeProtectionMapping,
  };
  const result: ResolveResult = {
    policy: cleanPolicy(policy, "workspace_readwrite"),
  };
  if (debug) {
    result.debug = { fieldSources: common.fieldSources };
  }
  return result;
}

function mergeWorkspaceReadOnlyPolicies(sources: PolicySources, options?: MergeOptions): ResolveResult {
  const debug = options?.debug;
  const common = mergeCommonWorkspaceFields(sources, options);
  const policy = {
    type: "workspace_readonly",
    disableTmpWrite: common.disableTmpWrite,
    networkPolicyStrict: common.networkPolicyStrict,
    readBoundary: common.readBoundary,
    additionalReadPaths: common.additionalReadPaths,
    additionalReadonlyPaths: common.additionalReadonlyPaths,
    networkPolicy: common.networkPolicy,
    debugOutputDir: common.debugOutputDir,
    captureDenies: common.captureDenies,
    enableSharedBuildCache: common.enableSharedBuildCache,
    ignoreMapping: common.ignoreMapping,
    writeProtectionMapping: common.writeProtectionMapping,
  };
  const result: ResolveResult = {
    policy: cleanPolicy(policy, "workspace_readonly"),
  };
  if (debug) {
    result.debug = { fieldSources: common.fieldSources };
  }
  return result;
}

function mergeInsecureNonePolicies(sources: PolicySources, options?: MergeOptions): ResolveResult {
  const { perUser, perRepo, teamAdmin } = sources;
  const debug = options?.debug;
  const fieldSources: Record<string, string> = {};
  const allowlistEscalated = mergeRestrictiveBoolean(perUser?.allowlistEscalated, perRepo?.allowlistEscalated, teamAdmin?.allowlistEscalated);
  const debugOutputDir = takeHighestPriorityDefined(perUser?.debugOutputDir, perRepo?.debugOutputDir, teamAdmin?.debugOutputDir);
  const captureDenies = mergeRestrictiveBoolean(perUser?.captureDenies, perRepo?.captureDenies, teamAdmin?.captureDenies);
  const enableSharedBuildCache = takeHighestPriorityDefined(perUser?.enableSharedBuildCache, perRepo?.enableSharedBuildCache, teamAdmin?.enableSharedBuildCache);
  const policy = {
    type: "insecure_none",
    allowlistEscalated: allowlistEscalated || undefined,
    debugOutputDir,
    captureDenies: captureDenies || undefined,
    enableSharedBuildCache,
  };
  const cleaned = Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== undefined));
  cleaned.type = "insecure_none";
  const result: ResolveResult = {
    policy: cleaned as ResolvedPolicy,
  };
  if (debug) {
    result.debug = { fieldSources };
  }
  return result;
}
