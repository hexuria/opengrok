const FORCED_SHELL_EGRESS_ENV = "CURSOR_FORCED_SHELL_EGRESS";
const FORCED_SHELL_EGRESS_DEPENDENCY_REGEX_ENV = "CURSOR_FORCED_SHELL_EGRESS_DEPENDENCY_REGEX";
const FORCED_SHELL_EGRESS_EXTRA_DEPENDENCY_REGEX_ENV = "CURSOR_FORCED_SHELL_EGRESS_EXTRA_DEPENDENCY_REGEX";
const FORCED_SHELL_EGRESS_SOURCE_REGEX_ENV = "CURSOR_FORCED_SHELL_EGRESS_SOURCE_REGEX";
const FORCED_SHELL_EGRESS_EXTRA_SOURCE_REGEX_ENV = "CURSOR_FORCED_SHELL_EGRESS_EXTRA_SOURCE_REGEX";
const FORCED_SHELL_EGRESS_NETWORK_DEFAULT_ENV = "CURSOR_FORCED_SHELL_EGRESS_NETWORK_DEFAULT";
const FORCED_SHELL_EGRESS_DENY_DOMAINS_ENV = "CURSOR_FORCED_SHELL_EGRESS_DENY_DOMAINS";
const FORCED_SHELL_EGRESS_DEPENDENCY_DENY_DOMAINS_ENV = "CURSOR_FORCED_SHELL_EGRESS_DEPENDENCY_DENY_DOMAINS";
const FORCED_SHELL_EGRESS_ALLOW_DOMAINS_ENV = "CURSOR_FORCED_SHELL_EGRESS_ALLOW_DOMAINS";
const FORCED_SHELL_EGRESS_WRITABLE_PATHS_ENV = "CURSOR_FORCED_SHELL_EGRESS_WRITABLE_PATHS";
const SUBSTITUTION_RE = /\$\(|`|<\(|>\(/;
const CONTROL_OPERATOR_RE = /[;&|]/;
const ENV_ASSIGNMENT_PREFIX = "(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s]*\\s+)*";

let cachedEnabled: boolean | undefined;
let cachedDependencyRe: RegExp | null | undefined;
let cachedSourceLookupRe: RegExp | null | undefined;
let cachedPolicyOverrides: PolicyOverrides | undefined;

export interface ForcedEgressCommand {
  readonly fullText?: string | undefined;
  readonly name?: string | undefined;
}

export interface ForcedEgressParsingResult {
  readonly parsingFailed?: boolean | undefined;
  readonly executableCommands?: readonly ForcedEgressCommand[] | undefined;
}

export interface ForcedEgressSandboxPolicy {
  readonly type: "workspace_readwrite";
  readonly additionalReadwritePaths?: string[];
  readonly networkPolicy: {
    readonly version: 1;
    readonly default: "allow" | "deny";
    readonly allow?: string[];
    readonly deny?: string[];
  };
  readonly networkPolicyStrict?: true;
  readonly skipStatsigDefaults: true;
  readonly enableSharedBuildCache: true;
}

interface PolicyOverrides {
  readonly networkDefault: "allow" | "deny";
  readonly denyDomains: string[];
  readonly dependencyDenyDomains: string[];
  readonly allowDomains: string[];
  readonly writablePaths: string[];
}

function isForcedShellEgressEnabled(): boolean {
  if (cachedEnabled === undefined) {
    const raw = (process.env[FORCED_SHELL_EGRESS_ENV] ?? "").trim().toLowerCase();
    cachedEnabled = raw !== "" && raw !== "0" && raw !== "false" && raw !== "off";
  }
  return cachedEnabled;
}

function requiredRegexSource(envVar: string): string | undefined {
  const raw = (process.env[envVar] ?? "").trim();
  if (!raw) return undefined;
  try {
    new RegExp(raw, "i");
    return raw;
  } catch (error) {
    throw new Error(`[forced-egress] invalid regex in ${envVar}: ${String(error)}`);
  }
}

function parseDomainListEnv(envVar: string): string[] {
  return (process.env[envVar] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function parseWritablePathsEnv(envVar: string): string[] {
  const entries = (process.env[envVar] ?? "").split(":").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const absolute = entries.filter((entry) => entry.startsWith("/"));
  const dropped = entries.length - absolute.length;
  if (dropped > 0) {
    console.error(`[forced-egress] ignoring ${dropped} non-absolute path(s) in ${envVar}.`);
  }
  return absolute;
}

function policyOverrides(): PolicyOverrides {
  if (cachedPolicyOverrides === undefined) {
    const rawDefault = (process.env[FORCED_SHELL_EGRESS_NETWORK_DEFAULT_ENV] ?? "").trim().toLowerCase();
    let networkDefault: "allow" | "deny" = "deny";
    if (rawDefault === "allow" || rawDefault === "deny") {
      networkDefault = rawDefault;
    } else if (rawDefault !== "") {
      console.error(`[forced-egress] ignoring invalid value in ${FORCED_SHELL_EGRESS_NETWORK_DEFAULT_ENV} (expected "allow" or "deny"); using "deny".`);
    }
    const denyDomains = parseDomainListEnv(FORCED_SHELL_EGRESS_DENY_DOMAINS_ENV);
    const rawDependencyDeny = (process.env[FORCED_SHELL_EGRESS_DEPENDENCY_DENY_DOMAINS_ENV] ?? "").trim();
    let dependencyDenyDomains = denyDomains;
    if (rawDependencyDeny.toLowerCase() === "none") {
      dependencyDenyDomains = [];
    } else if (rawDependencyDeny !== "") {
      dependencyDenyDomains = parseDomainListEnv(FORCED_SHELL_EGRESS_DEPENDENCY_DENY_DOMAINS_ENV);
    }
    cachedPolicyOverrides = {
      networkDefault,
      denyDomains,
      dependencyDenyDomains,
      allowDomains: parseDomainListEnv(FORCED_SHELL_EGRESS_ALLOW_DOMAINS_ENV),
      writablePaths: parseWritablePathsEnv(FORCED_SHELL_EGRESS_WRITABLE_PATHS_ENV),
    };
  }
  return cachedPolicyOverrides;
}

function compileConfigurablePattern(overrideEnv: string, extraEnv: string, options: { readonly anchorToExecutable?: boolean } = {}): RegExp | null {
  const parts = [requiredRegexSource(overrideEnv), requiredRegexSource(extraEnv)].filter((part): part is string => part !== undefined).map((part) => `(?:${part})`);
  if (parts.length === 0) return null;
  const body = parts.join("|");
  const pattern = options.anchorToExecutable ? `^\\s*${ENV_ASSIGNMENT_PREFIX}(?:${body})` : body;
  return new RegExp(pattern, "i");
}

function dependencyRegex(): RegExp | null {
  if (cachedDependencyRe === undefined) {
    cachedDependencyRe = compileConfigurablePattern(FORCED_SHELL_EGRESS_DEPENDENCY_REGEX_ENV, FORCED_SHELL_EGRESS_EXTRA_DEPENDENCY_REGEX_ENV, { anchorToExecutable: true });
  }
  return cachedDependencyRe;
}

function sourceLookupRegex(): RegExp | null {
  if (cachedSourceLookupRe === undefined) {
    cachedSourceLookupRe = compileConfigurablePattern(FORCED_SHELL_EGRESS_SOURCE_REGEX_ENV, FORCED_SHELL_EGRESS_EXTRA_SOURCE_REGEX_ENV);
  }
  return cachedSourceLookupRe;
}

function forcedLoopbackEgressPolicy(): ForcedEgressSandboxPolicy {
  const overrides = policyOverrides();
  return {
    type: "workspace_readwrite",
    ...(overrides.writablePaths.length > 0 ? { additionalReadwritePaths: overrides.writablePaths } : {}),
    networkPolicy: {
      version: 1,
      default: overrides.networkDefault,
      allow: ["127.0.0.0/8", "::1/128", "localhost", ...overrides.allowDomains],
      ...(overrides.denyDomains.length > 0 ? { deny: overrides.denyDomains } : {}),
    },
    networkPolicyStrict: true,
    skipStatsigDefaults: true,
    enableSharedBuildCache: true,
  };
}

function forcedDependencyEgressPolicy(): ForcedEgressSandboxPolicy {
  const overrides = policyOverrides();
  return {
    type: "workspace_readwrite",
    ...(overrides.writablePaths.length > 0 ? { additionalReadwritePaths: overrides.writablePaths } : {}),
    networkPolicy: {
      version: 1,
      default: "allow",
      ...(overrides.dependencyDenyDomains.length > 0 ? { deny: overrides.dependencyDenyDomains } : {}),
    },
    skipStatsigDefaults: true,
    enableSharedBuildCache: true,
  };
}

export function forcedShellSandboxPolicy(command: string, parsingResult: ForcedEgressParsingResult | undefined): ForcedEgressSandboxPolicy {
  const loopback = forcedLoopbackEgressPolicy();
  const dependencyRe = dependencyRegex();
  if (dependencyRe === null) return loopback;
  const commands = parsingResult?.executableCommands ?? [];
  if (parsingResult?.parsingFailed || commands.length === 0) return loopback;
  if (SUBSTITUTION_RE.test(command)) return loopback;
  const sourceLookupRe = sourceLookupRegex();
  for (const cmd of commands) {
    const text = cmd.fullText?.trim() || cmd.name?.trim() || "";
    if (!text || sourceLookupRe?.test(text) || CONTROL_OPERATOR_RE.test(text)) return loopback;
  }
  const allDependency = commands.every((cmd) => dependencyRe.test(cmd.fullText?.trim() || cmd.name?.trim() || ""));
  return allDependency ? forcedDependencyEgressPolicy() : loopback;
}

export { isForcedShellEgressEnabled };
