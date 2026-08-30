import { requestIdKey } from "../../packages/chat-inference-proto/client.js";
import { shellExecutorResource } from "../../packages/agent-exec/shell.js";
import { delay } from "../../packages/utils/promise-extras.js";
import {
  buildHostShellArgs,
  type HostShellArgsInput,
} from "../box/box-shell-command.js";
import type { ShellArgs, ShellResult } from "../../packages/proto/generated/agent/v1/shell_exec_pb.js";
import type { ActionAuditor } from "./site-visit-tracking.js";

export function mcpAuditStatus(result: any): "ok" | "error" {
  if (result.result.case === "success") {
    return result.result.value.isError ? "error" : "ok";
  }
  return result.result.case === "approved" ? "ok" : "error";
}

export function wrapMcpExecutorForAudit<
  Context,
  Args extends { providerIdentifier: string; toolCallId?: string; name: string },
  Result,
>(
  inner: { execute(ctx: Context, args: Args, options?: unknown): Promise<Result> },
  deps: {
    agentId: string;
    auditor: ActionAuditor;
    resolveTransport(server: string): Promise<string>;
    getTurnId?(ctx: Context): string | undefined;
    now?: () => number;
  },
) {
  return {
    async execute(ctx: Context, args: Args, options?: unknown): Promise<Result> {
      const now = deps.now ?? Date.now;
      const startedAtMs = now();
      const transport = deps.resolveTransport(args.providerIdentifier).catch(() => "unknown");
      const report = (status: "ok" | "error"): void => {
        const durationMs = now() - startedAtMs;
        void transport.then(resolved => deps.auditor.record({
          agentId: deps.agentId,
          ...(deps.getTurnId?.(ctx) == null ? {} : { turnId: deps.getTurnId?.(ctx) }),
          occurredAtMs: startedAtMs,
          action: {
            kind: "mcpToolCall",
            toolCallId: args.toolCallId ?? "",
            serverIdentifier: args.providerIdentifier,
            serverName: args.providerIdentifier,
            toolName: args.name,
            transport: resolved,
            status,
            durationMs,
          },
        })).catch(() => {});
      };
      try {
        const result = await inner.execute(ctx, args, options);
        report(mcpAuditStatus(result));
        return result;
      } catch (error) {
        report("error");
        throw error;
      }
    },
  };
}

export const NAVIGATION_PROBE_CDP_BASE_PORT = 9_222;
export const NAVIGATION_PROBE_MIN_INTERVAL_MS = 2_000;
export const IGNORED_URL_PREFIXES = [
  "about:",
  "chrome://",
  "chrome-extension://",
  "chrome-untrusted://",
  "devtools://",
];

export function navigationProbeCommand(displayNumber: number): string {
  const port = NAVIGATION_PROBE_CDP_BASE_PORT + displayNumber;
  return `curl -sf --max-time 2 "http://127.0.0.1:${port}/json/list"`;
}

export function normalizeNavigationUrl(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return undefined;
  for (const prefix of IGNORED_URL_PREFIXES) {
    if (trimmed.startsWith(prefix)) return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.origin === "null") return undefined;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

export function parseNavigationProbeOutput(stdout: string): Record<string, unknown>[] {
  const targets: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < stdout.length; index += 1) {
    const character = stdout[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[" || character === "{") {
      if (depth === 0 && character === "[") start = index;
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed: unknown = JSON.parse(stdout.slice(start, index + 1));
          if (Array.isArray(parsed)) {
            for (const entry of parsed) {
              if (typeof entry === "object" && entry != null) targets.push(entry as Record<string, unknown>);
            }
          }
        } catch {}
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return targets;
}

export interface NavigationProbeDependencies<Context> {
  readonly agentId: string;
  readonly auditor: ActionAuditor;
  readonly now?: () => number;
  readonly getBoxId?: () => string;
  readonly getTurnId?: (ctx: Context) => string | undefined;
  /** Exact immutable path: generated ShellArgs plus the bound Shell resource. */
  readonly buildShellArgs?: ((input: HostShellArgsInput) => ShellArgs) | undefined;
  /** Legacy coordinator input retained until its production consumer flips. */
  readonly executeShell?: ((ctx: Context, args: HostShellArgsInput) => Promise<ShellResult>) | undefined;
}

interface GeneratedShellAccessor<Context> {
  get(resource: typeof shellExecutorResource): {
    execute(context: Context, args: ShellArgs): Promise<ShellResult>;
  };
}

function isGeneratedShellAccessor<Context>(value: unknown): value is GeneratedShellAccessor<Context> {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "get") === "function";
}

function requestIdFromContext(value: unknown): string | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  const get = Reflect.get(value, "get");
  if (typeof get !== "function") return undefined;
  const requestId: unknown = get.call(value, requestIdKey);
  return typeof requestId === "string" ? requestId : undefined;
}

export function createSandNavigationProbe<Context>(deps: NavigationProbeDependencies<Context>) {
  const now = deps.now ?? Date.now;
  const lastUrlByPageId = new Map<string, string>();
  let lastProbeAtMs = 0;
  let inFlight = false;
  let trailingScheduled = false;
  let baselineInFlight = false;
  let queuedDuringBaseline: {
    readonly ctx: Context;
    readonly remoteAccessor: unknown;
    readonly displayNumber: number;
  } | null = null;
  let lastRequestedTurnId: string | undefined;

  const runProbe = async (
    context: Context,
    remoteAccessor: unknown,
    displayNumber: number,
    mode: "baseline" | "report",
  ): Promise<void> => {
    if (!Number.isInteger(displayNumber) || displayNumber < 0) return;
    const input: HostShellArgsInput = {
      command: navigationProbeCommand(displayNumber),
      name: "curl",
      workingDirectory: "/workspace",
      toolCallId: "sand-navigation-probe",
    };
    if (!isGeneratedShellAccessor(remoteAccessor)) return;
    const result = await remoteAccessor.get(shellExecutorResource).execute(
      context,
      (deps.buildShellArgs ?? buildHostShellArgs)(input),
    );
    if (result.result.case !== "success" || result.result.value.exitCode !== 0) return;
    const occurredAtMs = now();
    for (const target of parseNavigationProbeOutput(result.result.value.stdout)) {
      if (target.type !== "page") continue;
      const pageId = typeof target.id === "string" ? target.id : "";
      if (pageId.length === 0) continue;
      const url = normalizeNavigationUrl(typeof target.url === "string" ? target.url : "");
      if (url === undefined || lastUrlByPageId.get(pageId) === url) continue;
      lastUrlByPageId.set(pageId, url);
      if (mode === "baseline") continue;
      deps.auditor.record({
        agentId: deps.agentId,
        ...(lastRequestedTurnId === undefined ? {} : { turnId: lastRequestedTurnId }),
        ...(deps.getBoxId?.() === undefined ? {} : { boxId: deps.getBoxId?.() }),
        occurredAtMs,
        action: { kind: "browserNavigation", url, pageTitle: typeof target.title === "string" ? target.title : "" },
      });
    }
  };

  const legacyProbe = async (context: Context, displayNumber: number, mode: "baseline" | "report"): Promise<void> => {
    if (deps.executeShell === undefined) return;
    const result = await deps.executeShell(context, {
      command: navigationProbeCommand(displayNumber),
      name: "curl",
      workingDirectory: "/workspace",
      toolCallId: "sand-navigation-probe",
    });
    if (result.result.case !== "success" || result.result.value?.exitCode !== 0) return;
    const occurredAtMs = now();
    for (const target of parseNavigationProbeOutput(result.result.value.stdout ?? "")) {
      if (target.type !== "page") continue;
      const pageId = typeof target.id === "string" ? target.id : "";
      if (pageId.length === 0) continue;
      const url = normalizeNavigationUrl(typeof target.url === "string" ? target.url : "");
      if (url === undefined || lastUrlByPageId.get(pageId) === url) continue;
      lastUrlByPageId.set(pageId, url);
      if (mode === "baseline") continue;
      deps.auditor.record({
        agentId: deps.agentId,
        ...(lastRequestedTurnId === undefined ? {} : { turnId: lastRequestedTurnId }),
        ...(deps.getBoxId?.() === undefined ? {} : { boxId: deps.getBoxId?.() }),
        occurredAtMs,
        action: { kind: "browserNavigation", url, pageTitle: typeof target.title === "string" ? target.title : "" },
      });
    }
  };

  const run = (context: Context, remoteAccessor: unknown, displayNumber: number, mode: "baseline" | "report") =>
    isGeneratedShellAccessor<Context>(remoteAccessor)
      ? runProbe(context, remoteAccessor, displayNumber, mode)
      : legacyProbe(context, displayNumber, mode);

  const requestProbe = (context: Context, remoteAccessor: unknown, displayNumber: number): void => {
    if (baselineInFlight) {
      queuedDuringBaseline = { ctx: context, remoteAccessor, displayNumber };
      return;
    }
    const at = now();
    if (inFlight || at - lastProbeAtMs < NAVIGATION_PROBE_MIN_INTERVAL_MS) {
      if (!trailingScheduled) {
        trailingScheduled = true;
        void delay(NAVIGATION_PROBE_MIN_INTERVAL_MS).then(() => {
          trailingScheduled = false;
          requestProbe(context, remoteAccessor, displayNumber);
        });
      }
      return;
    }
    lastProbeAtMs = at;
    inFlight = true;
    void run(context, remoteAccessor, displayNumber, "report").catch(() => {}).finally(() => { inFlight = false; });
  };

  const probe = (context: Context, remoteAccessor: unknown, displayNumber: number): void => {
    lastRequestedTurnId = deps.getTurnId?.(context) ?? requestIdFromContext(context);
    requestProbe(context, remoteAccessor, displayNumber);
  };

  let baselinePromise: Promise<void> | undefined;
  const captureBaseline = (
    context: Context,
    remoteAccessor: unknown,
    displayNumber: number,
  ): Promise<void> => {
    if (baselinePromise !== undefined) return baselinePromise;
    inFlight = true;
    baselineInFlight = true;
    baselinePromise = run(context, remoteAccessor, displayNumber, "baseline").catch(() => {}).finally(() => {
      inFlight = false;
      baselineInFlight = false;
      const queued = queuedDuringBaseline;
      queuedDuringBaseline = null;
      if (queued !== null) requestProbe(queued.ctx, queued.remoteAccessor, queued.displayNumber);
    });
    return baselinePromise;
  };

  return { probe, captureBaseline };
}

export function computerUseAuditKind(actionCase: string): string | undefined {
  switch (actionCase) {
    case "screenshot": return "screenshot";
    case "click": return "click";
    case "mouseMove": return "mouse_move";
    case "drag": return "drag";
    case "type": return "type";
    case "key": return "key";
    case "scroll": return "scroll";
    case "wait": return "wait";
    default: return undefined;
  }
}
