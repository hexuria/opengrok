import { randomUUID } from "node:crypto";
import { Resolver, lookup } from "node:dns/promises";
import { DeadlineExceededError, createDeadlinePolicy, realClock, type Clock, type DeadlinePolicy } from "../../internal/scheduling.js";
import { findSystemErrno } from "../../shared/system-errno.js";

export const DNS_PROBE_TIMEOUT_MS = 2_000;
export const DNS_PROBE_MIN_INTERVAL_MS = 60_000;
export const GENERAL_CONTROL_HOSTNAME = "api2.cursor.sh";

export type DnsProbeResult = "resolved" | "timeout" | "not_found" | "temporary_failure" | "error";
export type DnsDiagnosis = "resolved_before_probe" | "system_path_failure" | "independent_path_failure" | "endpoint_failure" | "cursorvm_failure" | "general_dns_failure" | "inconclusive";

interface DnsTarget {
  endpointHostname: string;
  wildcardHostname: string;
  cluster: "dev4" | "us8";
}

export interface GatewayDnsDiagnostic {
  cluster: "dev4" | "us8";
  trigger: "not_found" | "temporary_failure" | "unknown";
  diagnosis: DnsDiagnosis;
  systemExact: DnsProbeResult;
  independentExact: DnsProbeResult;
  independentWildcard: DnsProbeResult;
  independentGeneral: DnsProbeResult;
}

function isAllowedCluster(value: string): value is DnsTarget["cluster"] {
  return value === "dev4" || value === "us8";
}

export function dnsTargetFromBaseUrl(baseUrl: string | null | undefined, createWildcardLabel: () => string): DnsTarget | undefined {
  if (baseUrl == null) return undefined;
  try {
    const url = new URL(baseUrl);
    const labels = url.hostname.split(".");
    if (url.protocol !== "https:" || labels.length !== 4 || labels[0] == null || labels[0].length === 0 || labels[1] == null || labels[2] !== "cursorvm" || labels[3] !== "com" || !isAllowedCluster(labels[1])) return undefined;
    const cluster = labels[1];
    const wildcardLabel = createWildcardLabel();
    if (!/^[a-z0-9-]{1,63}$/.test(wildcardLabel)) return undefined;
    return { endpointHostname: url.hostname, wildcardHostname: `${wildcardLabel}.${cluster}.cursorvm.com`, cluster };
  } catch {
    return undefined;
  }
}

export function classifyProbeError(error: unknown): Exclude<DnsProbeResult, "resolved"> {
  if (error instanceof DeadlineExceededError) return "timeout";
  switch (findSystemErrno(error)) {
    case "ENOTFOUND":
    case "ENODATA":
      return "not_found";
    case "EAI_AGAIN":
    case "ESERVFAIL":
    case "EREFUSED":
      return "temporary_failure";
    case "ETIMEOUT":
    case "ETIMEDOUT":
      return "timeout";
    default:
      return "error";
  }
}

export function classifyDnsDiagnosis(results: Omit<GatewayDnsDiagnostic, "cluster" | "trigger" | "diagnosis">): DnsDiagnosis {
  if (results.systemExact === "resolved" && results.independentExact === "resolved") return "resolved_before_probe";
  if (results.systemExact !== "resolved" && results.independentExact === "resolved") return "system_path_failure";
  if (results.systemExact === "resolved" && results.independentExact !== "resolved") return "independent_path_failure";
  if (results.independentExact !== "resolved" && results.independentWildcard === "resolved") return "endpoint_failure";
  if (results.independentExact !== "resolved" && results.independentWildcard !== "resolved" && results.independentGeneral === "resolved") return "cursorvm_failure";
  if (results.independentGeneral !== "resolved") return "general_dns_failure";
  return "inconclusive";
}

function triggerFromCause(causeSummary?: string): GatewayDnsDiagnostic["trigger"] {
  if (causeSummary?.includes("ENOTFOUND") === true) return "not_found";
  if (causeSummary?.includes("EAI_AGAIN") === true) return "temporary_failure";
  return "unknown";
}

export interface GatewayDnsDiagnosticReporterOptions {
  clock: Clock;
  deadline: DeadlinePolicy;
  systemLookup(hostname: string): Promise<unknown>;
  independentLookup(hostname: string): Promise<unknown>;
  createWildcardLabel(): string;
  onDiagnostic(diagnostic: GatewayDnsDiagnostic): void;
}

export class GatewayDnsDiagnosticReporter {
  private episodeActive = false;
  private probeInFlight = false;
  private lastProbeStartedAtMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: GatewayDnsDiagnosticReporterOptions) {}

  observe(report: { outcome: string; causeSummary?: string }, baseUrl?: string): void {
    if (report.outcome === "ok") {
      this.episodeActive = false;
      return;
    }
    if (report.outcome !== "dns" || this.episodeActive) return;
    const target = dnsTargetFromBaseUrl(baseUrl, this.options.createWildcardLabel);
    if (target == null) return;
    const now = this.options.clock.monotonicNow();
    if (this.probeInFlight || now - this.lastProbeStartedAtMs < DNS_PROBE_MIN_INTERVAL_MS) return;
    this.episodeActive = true;
    this.probeInFlight = true;
    this.lastProbeStartedAtMs = now;
    void this.run(target, triggerFromCause(report.causeSummary)).then(
      (diagnostic) => {
        this.probeInFlight = false;
        try { this.options.onDiagnostic(diagnostic); } catch { return; }
      },
      () => { this.probeInFlight = false; }
    );
  }

  private async run(target: DnsTarget, trigger: GatewayDnsDiagnostic["trigger"]): Promise<GatewayDnsDiagnostic> {
    const probe = async (resolve: () => Promise<unknown>): Promise<DnsProbeResult> => {
      try {
        await this.options.deadline.run(() => resolve());
        return "resolved";
      } catch (error) {
        return classifyProbeError(error);
      }
    };
    const [systemExact, independentExact, independentWildcard, independentGeneral] = await Promise.all([
      probe(() => this.options.systemLookup(target.endpointHostname)),
      probe(() => this.options.independentLookup(target.endpointHostname)),
      probe(() => this.options.independentLookup(target.wildcardHostname)),
      probe(() => this.options.independentLookup(GENERAL_CONTROL_HOSTNAME))
    ]);
    const results = { systemExact, independentExact, independentWildcard, independentGeneral };
    return { cluster: target.cluster, trigger, diagnosis: classifyDnsDiagnosis(results), ...results };
  }
}

export function createGatewayDnsDiagnosticReporter(onDiagnostic: (diagnostic: GatewayDnsDiagnostic) => void): GatewayDnsDiagnosticReporter {
  const resolver = new Resolver({ timeout: DNS_PROBE_TIMEOUT_MS, tries: 1 });
  return new GatewayDnsDiagnosticReporter({
    clock: realClock,
    deadline: createDeadlinePolicy(realClock, { name: "gateway-dns-diagnostic", timeoutMs: DNS_PROBE_TIMEOUT_MS }),
    systemLookup: (hostname) => lookup(hostname),
    independentLookup: (hostname) => resolver.resolve4(hostname),
    createWildcardLabel: () => `sand-dns-probe-${randomUUID()}`,
    onDiagnostic
  });
}
