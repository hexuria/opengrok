import {
  bucketClockSkewDeltaMs,
  sanitizeCrossClockDurationMs,
  SEND_DISPATCH_MAX_PLAUSIBLE_MS,
  TTFT_MAX_PLAUSIBLE_MS,
} from "./clock-skew-guard.js";
import { MCP_TOOL_CALL_OUTLINE_NAME } from "./conversation-outline.js";
import {
  createRealExpiryPolicy,
  type ExpiryPolicy,
} from "../../internal/scheduling.js";
import { decodeBackgroundWorkMetadata } from "../../packages/agent-exec/background-work-metadata.js";

export const MCP_EXEC_STALL_THRESHOLD_MS = 15 * 60 * 1_000;

export interface AsyncTask {
  readonly kind: "subagent" | "shell" | "cloud-agent";
  readonly id: string;
  readonly label: string;
  readonly status: "running";
  readonly startedAtMs: number;
  readonly detail?: string;
  readonly subagentType?: string;
}

export interface ToolActivity {
  readonly status: "pending" | "done" | "failed";
  readonly name: string;
  readonly summary?: string;
}

export interface TurnObservationHost {
  getConversationId(): string;
  isActiveRunCanceled?(): boolean;
  isActiveRunInterrupted?(): boolean;
  subagentRegistryEntries?(): Iterable<
    readonly [
      string,
      {
        readonly status: string;
        readonly title: string;
        readonly startedAtMs: number;
        readonly subagentType: string;
      },
    ]
  >;
  isSubagentAborting?(id: string): boolean;
  listBackgroundShellWork?(): readonly {
    readonly id: string;
    readonly state: string;
    readonly metadata?: unknown;
  }[];
  shellRewatchEntries?(): Iterable<
    readonly [
      string,
      { readonly title: string; readonly startedAtMs: number },
    ]
  >;
  cloudAgentWatchEntries?(): Iterable<
    readonly [
      string,
      { readonly title: string; readonly startedAtMs: number },
    ]
  >;
}

export interface DispatchObservationInput {
  readonly hostReceiptPerfMs: number;
  readonly enterEpochMs?: number;
  readonly conversationId: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly isFork: boolean;
  readonly resolveModelId: () => string;
  readonly setRunAttribute: (
    key: string,
    value: string | number | boolean,
  ) => void;
  readonly addRunEvent: (
    name: string,
    attributes: Record<string, string>,
  ) => void;
}

export interface TurnObservationTiming {
  readonly mcpExecStallExpiry?: ExpiryPolicy;
}

export function createTurnObservation(
  host: TurnObservationHost & {
    readonly now?: () => number;
    readonly performanceNow?: () => number;
    readonly onEvent?: (event: unknown) => void;
  },
  timing: TurnObservationTiming = {},
) {
  const now = host.now ?? Date.now;
  const performanceNow = host.performanceNow ?? (() => performance.now());
  const mcpExecStallExpiry = timing.mcpExecStallExpiry
    ?? createRealExpiryPolicy({
      name: "sand-mcp-exec-stall",
      ttlMs: MCP_EXEC_STALL_THRESHOLD_MS,
    });
  let turnStartedAt = now();
  let lastTool: string | undefined;
  let onToolCallDiagnostic: ((event: unknown) => void) | undefined;
  let onAsyncTasksChanged:
    | ((event: {
      parentAgentId: string;
      tasks: readonly AsyncTask[];
    }) => void)
    | undefined;
  let onTurnAwait: ((event: unknown) => void) | undefined;
  let onTurnRetry: ((event: unknown) => void) | undefined;
  let onFirstToken: ((event: unknown) => void) | undefined;
  let onSendDispatch: ((event: unknown) => void) | undefined;

  const recentActivity: string[] = [];
  let observedToolCallCount = 0;
  let awaitObservationCount = 0;
  const pendingAwaits = new Map<
    string,
    { readonly index: number; readonly blockUntilMs: number }
  >();

  function turnStarted(): void {
    turnStartedAt = now();
    host.onEvent?.({ type: "turn-started", at: turnStartedAt });
  }

  function toolStarted(name: string): void {
    lastTool = name;
    recordToolActivity({ status: "pending", name });
    host.onEvent?.({ type: "tool-started", name, at: now() });
  }

  function toolCompleted(name: string, failed = false): void {
    if (lastTool === name) lastTool = undefined;
    recordToolActivity({
      status: failed ? "failed" : "done",
      name,
    });
    host.onEvent?.({ type: "tool-completed", name, at: now() });
  }

  function setToolCallDiagnosticHandler(
    handler: (event: unknown) => void,
  ): void {
    onToolCallDiagnostic = handler;
  }

  function beginMcpExecObservation(call: {
    readonly toolCallId: string;
    readonly connector: string;
    readonly requestId?: string;
  }): (errorClass?: string) => void {
    const startedPerfMs = performanceNow();
    const stallArm = mcpExecStallExpiry.arm(call.toolCallId, () => {
      onToolCallDiagnostic?.({
        kind: "stalled",
        toolCallId: call.toolCallId,
        toolName: MCP_TOOL_CALL_OUTLINE_NAME,
        connector: call.connector,
        elapsedMs: Math.round(performanceNow() - startedPerfMs),
        ...(call.requestId == null
          ? {}
          : { requestId: call.requestId }),
      });
    });

    let settled = false;
    return (errorClass?: string): void => {
      if (settled) return;
      settled = true;
      stallArm.dispose();
      if (errorClass === undefined) return;
      onToolCallDiagnostic?.({
        kind: "error",
        toolCallId: call.toolCallId,
        toolName: MCP_TOOL_CALL_OUTLINE_NAME,
        connector: call.connector,
        errorClass,
        durationMs: Math.round(performanceNow() - startedPerfMs),
        ...(call.requestId == null
          ? {}
          : { requestId: call.requestId }),
      });
    };
  }

  function observeAwaitToolCall(
    event: "toolCallStarted" | "toolCallCompleted",
    callId: string,
    awaitCall: {
      readonly blockUntilMs?: number;
      readonly result?: string;
    },
  ): void {
    if (onTurnAwait == null) return;
    const blockUntilMs = Math.max(
      0,
      awaitCall.blockUntilMs ?? 0,
    );
    if (event === "toolCallStarted") {
      pendingAwaits.set(callId, {
        index: ++awaitObservationCount,
        blockUntilMs,
      });
      return;
    }

    const pending = pendingAwaits.get(callId);
    pendingAwaits.delete(callId);
    onTurnAwait({
      awaitIndex: pending?.index ?? ++awaitObservationCount,
      blockUntilMs: pending?.blockUntilMs ?? blockUntilMs,
      outcome: host.isActiveRunCanceled?.() === true
        ? cancelledAwaitOutcome()
        : awaitCall.result === "timeout"
          ? "timeout"
          : "completed",
    });
  }

  function cancelledAwaitOutcome(): "aborted" | "clean_stop" {
    return host.isActiveRunInterrupted?.() === true
      ? "aborted"
      : "clean_stop";
  }

  function flushPendingAwaitsOnUnwind(): void {
    if (onTurnAwait != null) {
      const outcome = cancelledAwaitOutcome();
      for (const pending of pendingAwaits.values()) {
        onTurnAwait({
          awaitIndex: pending.index,
          blockUntilMs: pending.blockUntilMs,
          outcome,
        });
      }
    }
    pendingAwaits.clear();
    awaitObservationCount = 0;
  }

  function recordToolActivity(update: ToolActivity): void {
    if (update.status === "done" || update.status === "failed") {
      observedToolCallCount += 1;
    }
    const summary = update.summary != null
      && update.summary.length > 0
      ? `: ${update.summary}`
      : "";
    const line = `[${update.status}] ${update.name}${summary}`;
    if (recentActivity.at(-1) === line) return;
    recentActivity.push(line);
    if (recentActivity.length > 24) {
      recentActivity.splice(0, recentActivity.length - 24);
    }
  }

  function listAsyncTasks(): AsyncTask[] {
    const tasks: AsyncTask[] = [];

    for (const [subagentId, record] of
      host.subagentRegistryEntries?.() ?? []) {
      if (
        record.status !== "running"
        || host.isSubagentAborting?.(subagentId) === true
      ) continue;
      tasks.push({
        kind: "subagent",
        id: subagentId,
        label: record.title,
        status: "running",
        startedAtMs: record.startedAtMs,
        detail: record.subagentType,
        subagentType: record.subagentType,
      });
    }

    const registeredShellIds = new Set<string>();
    for (const work of host.listBackgroundShellWork?.() ?? []) {
      if (work.state !== "running") continue;
      registeredShellIds.add(work.id);
      const metadataRecord = typeof work.metadata === "object"
        && work.metadata !== null
        && !Array.isArray(work.metadata)
        ? Object.fromEntries(Object.entries(work.metadata))
        : undefined;
      const metadata = decodeBackgroundWorkMetadata(metadataRecord);
      tasks.push({
        kind: "shell",
        id: work.id,
        label: metadata.title
          ?? `Background command ${work.id}`,
        status: "running",
        startedAtMs: metadata.startTimeMs ?? 0,
      });
    }

    for (const [shellId, rewatch] of
      host.shellRewatchEntries?.() ?? []) {
      if (registeredShellIds.has(shellId)) continue;
      tasks.push({
        kind: "shell",
        id: shellId,
        label: rewatch.title,
        status: "running",
        startedAtMs: rewatch.startedAtMs,
        detail: "reattached after a host restart",
      });
    }

    for (const [bcId, watch] of
      host.cloudAgentWatchEntries?.() ?? []) {
      tasks.push({
        kind: "cloud-agent",
        id: bcId,
        label: watch.title,
        status: "running",
        startedAtMs: watch.startedAtMs,
      });
    }

    return tasks.sort(
      (left, right) =>
        left.startedAtMs - right.startedAtMs
        || left.id.localeCompare(right.id),
    );
  }

  function emitAsyncTasksChanged(): void {
    const parentAgentId = host.getConversationId();
    if (parentAgentId.length === 0) {
      throw new TypeError("async-task owner conversation id is unavailable");
    }
    onAsyncTasksChanged?.({
      parentAgentId,
      tasks: listAsyncTasks(),
    });
  }

  function armDispatchObservation(
    input: DispatchObservationInput,
  ) {
    let pendingFirstToken:
      | ((modelId?: string) => void)
      | undefined;
    let resolvedModelId: string | undefined;
    const dispatchPerfMs = performanceNow();
    const dispatchEpochMs = now();

    if (
      input.enterEpochMs !== undefined
      && Number.isFinite(input.enterEpochMs)
    ) {
      try {
        const hostDispatchMs = Math.max(
          0,
          Math.round(
            dispatchPerfMs - input.hostReceiptPerfMs,
          ),
        );
        const rawDeltaMs =
          dispatchEpochMs - input.enterEpochMs;
        const sanitized = sanitizeCrossClockDurationMs(
          rawDeltaMs,
          SEND_DISPATCH_MAX_PLAUSIBLE_MS,
        );
        const skew = "skewReason" in sanitized;
        if ("ms" in sanitized) {
          input.setRunAttribute(
            "sand.send_dispatch_ms",
            sanitized.ms,
          );
        } else {
          input.setRunAttribute(
            "sand.send_dispatch_skew_reason",
            sanitized.skewReason,
          );
        }
        input.setRunAttribute(
          "sand.send_dispatch_host_ms",
          hostDispatchMs,
        );
        onSendDispatch?.({
          dispatchMs: "ms" in sanitized
            ? sanitized.ms
            : undefined,
          hostDispatchMs,
          skew,
          skewReason: "skewReason" in sanitized
            ? sanitized.skewReason
            : undefined,
          skewBucket: skew
            ? bucketClockSkewDeltaMs(rawDeltaMs)
            : undefined,
          isFork: input.isFork,
          modelId: input.resolveModelId(),
          traceId: input.traceId,
          spanId: input.spanId,
        });
      } catch {
        // Instrumentation failures must not alter turn execution.
      }
    }

    let firstTokenObserved = false;
    const observeFirstToken = (chunkType: string): void => {
      if (firstTokenObserved) return;
      firstTokenObserved = true;
      try {
        const rawTtftMs = performanceNow() - dispatchPerfMs;
        const sanitized = sanitizeCrossClockDurationMs(
          rawTtftMs,
          TTFT_MAX_PLAUSIBLE_MS,
        );
        const skew = "skewReason" in sanitized;
        if ("ms" in sanitized) {
          input.setRunAttribute("sand.ttft_ms", sanitized.ms);
        } else {
          input.setRunAttribute(
            "sand.ttft_skew_reason",
            sanitized.skewReason,
          );
        }
        input.addRunEvent("first_token", {
          chunk_type: chunkType,
        });
        const emit = (modelId?: string): void => {
          onFirstToken?.({
            ttftMs: "ms" in sanitized
              ? sanitized.ms
              : undefined,
            skew,
            skewReason: "skewReason" in sanitized
              ? sanitized.skewReason
              : undefined,
            chunkType,
            isFork: input.isFork,
            modelId: modelId ?? input.resolveModelId(),
            traceId: input.traceId,
            spanId: input.spanId,
          });
        };
        if (resolvedModelId !== undefined) emit(resolvedModelId);
        else pendingFirstToken = emit;
      } catch {
        // Instrumentation failures must not alter turn execution.
      }
    };

    return {
      observeFirstToken,
      noteModelResolved(modelId: string): void {
        resolvedModelId = modelId;
        const pending = pendingFirstToken;
        pendingFirstToken = undefined;
        pending?.(modelId);
      },
      settle(): void {
        const pending = pendingFirstToken;
        pendingFirstToken = undefined;
        pending?.();
      },
    };
  }

  return {
    turnStarted,
    toolStarted,
    toolCompleted,
    snapshot: () => ({
      elapsedMs: now() - turnStartedAt,
      lastTool,
    }),
    setTurnAwaitHandler: (
      handler: (event: unknown) => void,
    ): void => { onTurnAwait = handler; },
    setTurnRetryHandler: (
      handler: (event: unknown) => void,
    ): void => { onTurnRetry = handler; },
    setFirstTokenHandler: (
      handler: (event: unknown) => void,
    ): void => { onFirstToken = handler; },
    setSendDispatchHandler: (
      handler: (event: unknown) => void,
    ): void => { onSendDispatch = handler; },
    setAsyncTasksEventHandler: (
      handler: typeof onAsyncTasksChanged,
    ): void => { onAsyncTasksChanged = handler; },
    setToolCallDiagnosticHandler,
    beginMcpExecObservation,
    reportTurnRetry: (event: unknown): void =>
      onTurnRetry?.(event),
    emitFirstToken: (event: unknown): void =>
      onFirstToken?.(event),
    emitSendDispatch: (event: unknown): void =>
      onSendDispatch?.(event),
    armDispatchObservation,
    observeAwaitToolCall,
    cancelledAwaitOutcome,
    flushPendingAwaitsOnUnwind,
    recordToolActivity,
    getActivitySnapshot: (): string[] =>
      [...recentActivity],
    getObservedToolCallCount: (): number =>
      observedToolCallCount,
    emitAsyncTasksChanged,
    listAsyncTasks,
  };
}
