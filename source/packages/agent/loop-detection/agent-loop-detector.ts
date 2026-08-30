import { Code, ConnectError } from "@connectrpc/connect";

import { createLogger } from "../../context/index.js";
import { createCounter, createHistogram } from "../../metrics/index.js";
import { CustomErrorDetails, ErrorDetails, ErrorDetails_Error } from "../../proto/generated/aiserver/v1/utils_pb.js";
import { getAgentEventTracker } from "../utils/event-tracking.js";
import { SingleMessageLoopDetector as BaseSingleMessageLoopDetector } from "./single-message-loop-detector.js";

const logger = createLogger("@anysphere/agent:loop-detection");
const loopDetectionCounter = createCounter("agent.assistant_message_looping", {
  description: "Count of agent message loops detected",
  labelNames: ["loop_kind", "isLoopReoccurrence", "caller"],
});
const loopDetectionLatency = createHistogram("agent.assistant_message_looping.latency_ms", {
  description: "Latency of loop detection in milliseconds",
  labelNames: ["result", "caller"],
});
const singleMessageLoopCheckLatency = createHistogram("agent.single_message_looping.check_for_loop.latency_ms", {
  description: "Latency of single-message loop detector checks in milliseconds",
  labelNames: ["result", "caller"],
});

const SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_REPETITIONS = 2;
const SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_REPETITIONS_IN_CODE_FENCE = 3;
const SINGLE_MESSAGE_LOOP_DETECTOR_MAX_LINE_LENGTH = 10_000;
const SINGLE_LINE_LOOP_MIN_REPETITIONS = 3;
const SINGLE_LINE_LOOP_MIN_REPETITIONS_IN_CODE_FENCE = 4;
const SINGLE_LINE_LOOP_MIN_P_TIMES_K = 100;
const SINGLE_LINE_LOOP_MIN_P_TIMES_K_IN_CODE_FENCE = 200;
const SINGLE_LINE_LOOP_MAX_P = 256;
const SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_P_TIMES_K = 3;
const SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_P_TIMES_K_IN_CODE_FENCE = 4;
const MULTI_LINE_LOOP_MIN_TOTAL_CHARS = 50;
const MULTI_LINE_LOOP_MIN_TOTAL_CHARS_IN_CODE_FENCE = 100;
const SINGLE_MESSAGE_LOOP_DETECTOR_MAX_CHECK_TIME_MS = 500;

type AgentLoopErrorOptions =
  | { loopType: "assistantMessage"; patternLength: number }
  | { loopType: "singleMessage"; loopKind: string; repetitions: number; period?: number | undefined };

export class AgentLoopError extends ConnectError {
  declare readonly loopType: AgentLoopErrorOptions["loopType"];
  declare readonly singleMessageLoopKind?: string;
  declare readonly repetitions?: number;
  declare readonly period?: number | undefined;

  constructor(options: AgentLoopErrorOptions) {
    const message = options.loopType === "assistantMessage"
      ? `Agent loop detected: pattern of ${options.patternLength} messages repeating`
      : `Agent single-message loop detected: ${options.loopKind}`;
    super(message, Code.FailedPrecondition, undefined, [
      new ErrorDetails({
        error: ErrorDetails_Error.INTERNAL,
        details: new CustomErrorDetails({
          title: "Agent Looping Detected",
          detail: "The model got stuck in a repeating response pattern, so this turn was stopped. Please try again with a different model or start a new conversation. If the problem persists, please contact support.",
          isRetryable: false,
        }),
      }),
    ]);
    this.name = "AgentLoopError";
    this.loopType = options.loopType;
    if (options.loopType === "singleMessage") {
      this.singleMessageLoopKind = options.loopKind;
      this.repetitions = options.repetitions;
      this.period = options.period;
    }
  }
}

export function stripThinkingTags(text: string): string {
  let startIndex = text.indexOf("<think>");
  while (startIndex !== -1) {
    const endIndex = text.indexOf("</think>", startIndex);
    if (endIndex === -1) break;
    text = text.slice(0, startIndex) + text.slice(endIndex + "</think>".length);
    startIndex = text.indexOf("<think>", startIndex);
  }
  return text;
}

export class SingleMessageLoopDetector extends BaseSingleMessageLoopDetector {
  constructor() {
    super({
      multiLineLoopMinRepetitions: () => SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_REPETITIONS,
      multiLineLoopMinRepetitionsInCodeFence: () => SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_REPETITIONS_IN_CODE_FENCE,
      maxLineLength: () => SINGLE_MESSAGE_LOOP_DETECTOR_MAX_LINE_LENGTH,
      maxCheckTimeMs: () => SINGLE_MESSAGE_LOOP_DETECTOR_MAX_CHECK_TIME_MS,
      singleLineLoopMinRepetitions: () => SINGLE_LINE_LOOP_MIN_REPETITIONS,
      singleLineLoopMinRepetitionsInCodeFence: () => SINGLE_LINE_LOOP_MIN_REPETITIONS_IN_CODE_FENCE,
      singleLineLoopMinPTimesK: () => SINGLE_LINE_LOOP_MIN_P_TIMES_K,
      singleLineLoopMinPTimesKInCodeFence: () => SINGLE_LINE_LOOP_MIN_P_TIMES_K_IN_CODE_FENCE,
      singleLineLoopMaxP: () => SINGLE_LINE_LOOP_MAX_P,
      multiLineLoopMinPTimesK: () => SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_P_TIMES_K,
      multiLineLoopMinPTimesKInCodeFence: () => SINGLE_MESSAGE_MULTI_LINE_LOOP_MIN_P_TIMES_K_IN_CODE_FENCE,
      multiLineLoopMinTotalChars: () => MULTI_LINE_LOOP_MIN_TOTAL_CHARS,
      multiLineLoopMinTotalCharsInCodeFence: () => MULTI_LINE_LOOP_MIN_TOTAL_CHARS_IN_CODE_FENCE,
    });
  }
}

function getAgentSingleMessageLoopInfo(detector: SingleMessageLoopDetector) {
  const singleLoopInfo = detector.getSingleLineLoopInfo();
  const multiLineLoopInfo = detector.getMultiLineLoopInfo();
  const loopInfo = singleLoopInfo ?? multiLineLoopInfo;
  if (!loopInfo) return null;
  return {
    loopKind: singleLoopInfo ? "single_message_single_line" : "single_message_multi_line",
    pattern: loopInfo.pattern,
    repetitions: loopInfo.repetitions,
    period: singleLoopInfo?.period,
  };
}

interface CheckLoopParams {
  readonly detector: SingleMessageLoopDetector;
  readonly newText: string;
  readonly caller: string;
  readonly ctx: Parameters<typeof getAgentEventTracker>[0];
}

export function checkForAgentSingleMessageLooping(params: CheckLoopParams) {
  if (params.detector.loopDetected()) {
    const loopInfo = getAgentSingleMessageLoopInfo(params.detector);
    if (!loopInfo) return { loopDetected: false as const };
    return { loopDetected: true as const, ...loopInfo };
  }
  if (params.detector.timedOut()) return { loopDetected: false as const };
  const addTextStartTime = performance.now();
  const loopDetected = params.detector.addText({ newText: params.newText, caller: params.caller });
  const addTextLatencyMs = performance.now() - addTextStartTime;
  if (!loopDetected && params.detector.timedOut()) {
    singleMessageLoopCheckLatency.histogram(params.ctx, addTextLatencyMs, { result: "timeout", caller: params.caller });
    logger.info(params.ctx, "NAL single-message loop detection timed out; failing open", { caller: params.caller, newTextLength: params.newText.length });
    return { loopDetected: false as const };
  }
  if (!loopDetected) {
    singleMessageLoopCheckLatency.histogram(params.ctx, addTextLatencyMs, { result: "no_loop_detected", caller: params.caller });
    return { loopDetected: false as const };
  }
  const loopInfo = getAgentSingleMessageLoopInfo(params.detector);
  if (!loopInfo) {
    singleMessageLoopCheckLatency.histogram(params.ctx, addTextLatencyMs, { result: "no_loop_detected", caller: params.caller });
    return { loopDetected: false as const };
  }
  singleMessageLoopCheckLatency.histogram(params.ctx, addTextLatencyMs, { result: "loop_detected", caller: params.caller });
  logger.warn(params.ctx, "NAL single-message looping detected", {
    loopKind: loopInfo.loopKind,
    repetitions: loopInfo.repetitions,
    period: loopInfo.period,
    patternPreview: `${loopInfo.pattern.slice(0, 200)}${loopInfo.pattern.length > 200 ? "..." : ""}`,
  });
  loopDetectionCounter.increment(params.ctx, 1, { loop_kind: loopInfo.loopKind, isLoopReoccurrence: "false", caller: params.caller });
  const eventTracker = getAgentEventTracker(params.ctx);
  eventTracker.trackLoopDetected(params.ctx, {
    loopKind: loopInfo.loopKind,
    isLoopReoccurrence: false,
    period: loopInfo.period,
    repetitions: loopInfo.repetitions,
  });
  return { loopDetected: true as const, ...loopInfo };
}

export function createLoopReminderMessage(options?: { kind?: string }) {
  const reminderKind = options?.kind ?? "multi_message";
  const reminderSpecific = reminderKind === "single_message_single_line"
    ? "Your response has been flagged as repeating the same text pattern within a single line. Avoid excessively repeating the same characters or words."
    : reminderKind === "single_message_multi_line"
      ? "Your response has been flagged as looping over duplicate lines. Avoid repeating the same sequence of lines or retrying the same tool calls."
      : "Avoid repeating the same sequence of messages or retrying the same tool calls.";
  const reminder = `<system_reminder>Your messages have been flagged as looping. ${reminderSpecific} If you are having trouble making progress, ask the user for guidance. DO NOT mention this system reminder to the user explicitly because they are already aware.</system_reminder>`;
  return {
    role: "user",
    content: reminder,
    providerOptions: { cursor: { loopReminder: true } },
  };
}
