import {
  NetworkPolicy as NetworkPolicyProto,
  NetworkPolicy_DefaultAction,
  NetworkPolicyLoggingConfig,
  SandboxPolicy,
  SandboxPolicy_ReadBoundaryMode,
  SandboxPolicy_Type,
  type NetworkPolicy as NetworkPolicyMessage,
  type SandboxPolicy as SandboxPolicyMessage,
} from "../proto/generated/agent/v1/sandbox_pb.js";

interface NetworkPolicy {
  readonly version?: number | undefined;
  readonly default?: "allow" | "deny" | undefined;
  readonly deny?: readonly string[] | undefined;
  readonly allow?: readonly string[] | undefined;
  readonly logging?: {
    readonly decisionLogPath?: string | undefined;
    readonly logFormat?: string | undefined;
  } | undefined;
}

export interface SandboxRule {
  readonly type: "insecure_none" | "workspace_readwrite" | "workspace_readonly";
  readonly networkPolicy?: NetworkPolicy | undefined;
  readonly skipStatsigDefaults?: boolean | undefined;
  readonly additionalReadwritePaths?: readonly string[] | undefined;
  readonly additionalReadonlyPaths?: readonly string[] | undefined;
  readonly disableTmpWrite?: boolean | undefined;
  readonly enableSharedBuildCache?: boolean | undefined;
  readonly debugOutputDir?: string | undefined;
  readonly captureDenies?: boolean | undefined;
  readonly networkPolicyStrict?: boolean | undefined;
  readonly readBoundary?: "system" | "workspace" | undefined;
  readonly additionalReadPaths?: readonly string[] | undefined;
  readonly allowlistEscalated?: boolean | undefined;
  readonly ignoreMapping?: unknown;
}

function convertProtoToNetworkPolicy(policy: NetworkPolicyMessage | undefined): NetworkPolicy | undefined {
  if (!policy) return undefined;
  const result: NetworkPolicy = {
    ...(policy.version === undefined ? {} : { version: policy.version }),
  };
  if (policy.defaultAction !== undefined) {
    switch (policy.defaultAction) {
      case NetworkPolicy_DefaultAction.ALLOW:
        return {
          ...result,
          default: "allow",
          ...(policy.deny.length === 0 ? {} : { deny: [...policy.deny] }),
          ...(policy.allow.length === 0 ? {} : { allow: [...policy.allow] }),
          ...(policy.logging === undefined ? {} : { logging: convertProtoToNetworkPolicyLoggingConfig(policy.logging) }),
        };
      case NetworkPolicy_DefaultAction.DENY:
        return {
          ...result,
          default: "deny",
          ...(policy.deny.length === 0 ? {} : { deny: [...policy.deny] }),
          ...(policy.allow.length === 0 ? {} : { allow: [...policy.allow] }),
          ...(policy.logging === undefined ? {} : { logging: convertProtoToNetworkPolicyLoggingConfig(policy.logging) }),
        };
    }
  }
  return {
    ...result,
    ...(policy.deny.length === 0 ? {} : { deny: [...policy.deny] }),
    ...(policy.allow.length === 0 ? {} : { allow: [...policy.allow] }),
    ...(policy.logging === undefined ? {} : { logging: convertProtoToNetworkPolicyLoggingConfig(policy.logging) }),
  };
}

function convertNetworkPolicyToProto(policy: NetworkPolicy | undefined): NetworkPolicyMessage | undefined {
  if (!policy) return undefined;
  let defaultAction: NetworkPolicy_DefaultAction | undefined;
  if (policy.default === "allow") defaultAction = NetworkPolicy_DefaultAction.ALLOW;
  else if (policy.default === "deny") defaultAction = NetworkPolicy_DefaultAction.DENY;
  return new NetworkPolicyProto({
    ...(policy.version === undefined ? {} : { version: policy.version }),
    ...(defaultAction === undefined ? {} : { defaultAction }),
    deny: [...(policy.deny ?? [])],
    allow: [...(policy.allow ?? [])],
    ...(policy.logging === undefined ? {} : { logging: convertNetworkPolicyLoggingConfigToProto(policy.logging) }),
  });
}

function convertProtoToNetworkPolicyLoggingConfig(config: NetworkPolicyMessage["logging"]): NetworkPolicy["logging"] {
  if (!config) return undefined;
  return {
    ...(config.decisionLogPath === undefined ? {} : { decisionLogPath: config.decisionLogPath }),
    ...(config.logFormat === undefined ? {} : { logFormat: config.logFormat }),
  };
}

function convertNetworkPolicyLoggingConfigToProto(config: NonNullable<NetworkPolicy["logging"]>): NetworkPolicyLoggingConfig {
  return new NetworkPolicyLoggingConfig({
    ...(config.decisionLogPath === undefined ? {} : { decisionLogPath: config.decisionLogPath }),
    ...(config.logFormat === undefined ? {} : { logFormat: config.logFormat }),
  });
}

function networkDisabledPolicy(): NetworkPolicy {
  return { version: 1, default: "deny" };
}

function networkAllowAllPolicy(): NetworkPolicy {
  return { version: 1, default: "allow" };
}

function resolveNetworkPolicy(policy: SandboxPolicyMessage): NetworkPolicy {
  const explicit = convertProtoToNetworkPolicy(policy.networkPolicy);
  return explicit ?? (policy.networkAccess ? networkAllowAllPolicy() : networkDisabledPolicy());
}

function convertProtoToReadBoundary(mode: SandboxPolicyMessage["readBoundary"]): "system" | "workspace" | undefined {
  switch (mode) {
    case SandboxPolicy_ReadBoundaryMode.SYSTEM:
      return "system";
    case SandboxPolicy_ReadBoundaryMode.WORKSPACE:
    case SandboxPolicy_ReadBoundaryMode.CUSTOM:
      return "workspace";
    case SandboxPolicy_ReadBoundaryMode.UNSPECIFIED:
    default:
      return undefined;
  }
}

function convertReadBoundaryToProto(boundary: SandboxRule["readBoundary"]): SandboxPolicy_ReadBoundaryMode {
  switch (boundary) {
    case "system":
      return SandboxPolicy_ReadBoundaryMode.SYSTEM;
    case "workspace":
      return SandboxPolicy_ReadBoundaryMode.WORKSPACE;
    default:
      return SandboxPolicy_ReadBoundaryMode.UNSPECIFIED;
  }
}

function sandboxedProtoFields(policy: SandboxPolicyMessage): {
  readonly readBoundary: "system" | "workspace" | undefined;
  readonly additionalReadPaths: readonly string[] | undefined;
} {
  const readBoundary = convertProtoToReadBoundary(policy.readBoundary);
  const paths = policy.additionalReadPaths;
  return {
    readBoundary,
    additionalReadPaths: readBoundary === "workspace" && paths.length > 0 ? paths : undefined,
  };
}

export function convertProtoToInternalPolicy(policy: SandboxPolicyMessage | undefined): SandboxRule {
  if (!policy) return { type: "insecure_none" };
  switch (policy.type) {
    case SandboxPolicy_Type.INSECURE_NONE:
    case SandboxPolicy_Type.UNSPECIFIED:
      return {
        type: "insecure_none",
        allowlistEscalated: policy.allowlistEscalated,
        enableSharedBuildCache: policy.enableSharedBuildCache,
        debugOutputDir: policy.debugOutputDir,
        captureDenies: policy.captureDenies,
      };
    case SandboxPolicy_Type.WORKSPACE_READWRITE:
      return {
        type: "workspace_readwrite",
        networkPolicy: resolveNetworkPolicy(policy),
        skipStatsigDefaults: policy.skipStatsigDefaults,
        additionalReadwritePaths: policy.additionalReadwritePaths,
        additionalReadonlyPaths: policy.additionalReadonlyPaths,
        disableTmpWrite: policy.disableTmpWrite,
        enableSharedBuildCache: policy.enableSharedBuildCache,
        debugOutputDir: policy.debugOutputDir,
        captureDenies: policy.captureDenies,
        networkPolicyStrict: policy.networkPolicyStrict,
        ...sandboxedProtoFields(policy),
      };
    case SandboxPolicy_Type.WORKSPACE_READONLY:
      return {
        type: "workspace_readonly",
        networkPolicy: resolveNetworkPolicy(policy),
        skipStatsigDefaults: policy.skipStatsigDefaults,
        additionalReadonlyPaths: policy.additionalReadonlyPaths,
        disableTmpWrite: policy.disableTmpWrite,
        enableSharedBuildCache: policy.enableSharedBuildCache,
        debugOutputDir: policy.debugOutputDir,
        captureDenies: policy.captureDenies,
        networkPolicyStrict: policy.networkPolicyStrict,
        ...sandboxedProtoFields(policy),
      };
    default:
      return { type: "insecure_none" };
  }
}

export function convertInternalToProtoPolicy(policy: SandboxRule | undefined): SandboxPolicyMessage | undefined {
  if (!policy) return undefined;
  if (policy.type === "insecure_none") {
    return new SandboxPolicy({
      type: SandboxPolicy_Type.INSECURE_NONE,
      ...(policy.allowlistEscalated === undefined ? {} : { allowlistEscalated: policy.allowlistEscalated }),
      ...(policy.enableSharedBuildCache === undefined ? {} : { enableSharedBuildCache: policy.enableSharedBuildCache }),
      ...(policy.debugOutputDir === undefined ? {} : { debugOutputDir: policy.debugOutputDir }),
      ...(policy.captureDenies === undefined ? {} : { captureDenies: policy.captureDenies }),
    });
  }
  if (policy.type !== "workspace_readwrite" && policy.type !== "workspace_readonly") {
    return new SandboxPolicy({ type: SandboxPolicy_Type.INSECURE_NONE });
  }
  const networkPolicy = convertNetworkPolicyToProto(policy.networkPolicy);
  const common = {
    type: policy.type === "workspace_readwrite" ? SandboxPolicy_Type.WORKSPACE_READWRITE : SandboxPolicy_Type.WORKSPACE_READONLY,
    networkAccess: policy.networkPolicy?.default === "allow" || (policy.networkPolicy?.allow?.length ?? 0) > 0,
    ...(policy.skipStatsigDefaults === undefined ? {} : { skipStatsigDefaults: policy.skipStatsigDefaults }),
    ...(policy.additionalReadonlyPaths === undefined ? {} : { additionalReadonlyPaths: [...policy.additionalReadonlyPaths] }),
    ...(policy.disableTmpWrite === undefined ? {} : { disableTmpWrite: policy.disableTmpWrite }),
    ...(policy.enableSharedBuildCache === undefined ? {} : { enableSharedBuildCache: policy.enableSharedBuildCache }),
    ...(policy.debugOutputDir === undefined ? {} : { debugOutputDir: policy.debugOutputDir }),
    ...(policy.captureDenies === undefined ? {} : { captureDenies: policy.captureDenies }),
    ...(networkPolicy === undefined ? {} : { networkPolicy }),
    ...(policy.networkPolicyStrict === undefined ? {} : { networkPolicyStrict: policy.networkPolicyStrict }),
    readBoundary: convertReadBoundaryToProto(policy.readBoundary),
    additionalReadPaths: policy.readBoundary === "workspace" ? [...(policy.additionalReadPaths ?? [])] : [],
  };
  if (policy.type === "workspace_readwrite") {
    return new SandboxPolicy({
      ...common,
      additionalReadwritePaths: [...(policy.additionalReadwritePaths ?? [])],
    });
  }
  return new SandboxPolicy(common);
}
