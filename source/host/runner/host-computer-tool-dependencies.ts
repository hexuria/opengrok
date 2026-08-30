import {
  ComputerUseAction,
  ComputerUseArgs,
  Coordinate,
  ClickAction,
  CursorPositionAction,
  DragAction,
  KeyAction,
  MouseButton,
  MouseDownAction,
  MouseMoveAction,
  MouseUpAction,
  ScrollAction,
  ScrollDirection,
  ScreenshotAction,
  TypeAction,
  WaitAction,
  type ComputerUseResult as GeneratedComputerUseResult,
} from "../../packages/proto/generated/agent/v1/computer_use_tool_pb.js";
import { computerUseExecutorResource } from "../../packages/agent-exec/computer-use.js";
import { shellExecutorResource } from "../../packages/agent-exec/shell.js";
import type { Executor, ExecutorOptions } from "../../packages/agent-exec/remote.js";
import type { Context } from "../../packages/context/core.js";
import { buildHostShellArgs, type HostShellArgsInput } from "../box/box-shell-command.js";
import type { ShellArgs, ShellResult } from "../../packages/proto/generated/agent/v1/shell_exec_pb.js";
import type {
  ComputerProtocolAction,
  ComputerToolDependencies,
  ComputerUseResult,
  ReportedComputerAction,
} from "./tools/sand-computer-tool.js";
import type { BrowserDriverDependencies } from "./tools/sand-browser-tools.js";
import type { SandBrowserAutoReviewOptions } from "./sand-browser-auto-review.js";
import type { SandComputerAutoReviewOptions } from "./sand-computer-auto-review.js";

export interface HostComputerToolProjectionInput<Context = unknown> {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  readonly autoReview?: SandComputerAutoReviewOptions;
  readonly persistImage?: (
    bytes: Uint8Array,
    mimeType: string,
  ) => Promise<{ readonly fileUrl: string } | undefined>;
  readonly isUnicodeTypingEnabled?: () => boolean;
  readonly onComputerAction?: (action: ReportedComputerAction) => void;
}

export interface HostShellExecutorProjectionInput {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  readonly assertNoPendingApproval: () => void;
  readonly auditShellCommand: (command: string) => void;
}

export interface HostShellExecutor {
  execute(
    context: unknown,
    args: HostShellArgsInput,
    options?: ExecutorOptions,
  ): Promise<ShellResult>;
}

export interface HostBrowserBoxOwner<Context = unknown> {
  ensureReady(context: Context, agentId: string): Promise<unknown>;
  getAgentWindowIndex(agentId: string): number | undefined;
  uploadFile(context: Context, agentId: string, path: string, bytes: Uint8Array): Promise<void>;
  downloadFile(context: Context, agentId: string, path: string): Promise<Uint8Array>;
}

export interface HostBrowserDriverProjectionInput<Context = unknown> {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  readonly box: HostBrowserBoxOwner<Context>;
  readonly getBoxId: () => string;
  readonly getDefaultViewId: () => string;
  readonly executeShell: HostShellExecutor;
  readonly getPersistImage?: BrowserDriverDependencies<Context>["getPersistImage"];
  readonly autoReview?: SandBrowserAutoReviewOptions;
}

type ActionValue = Readonly<Record<string, unknown>>;

function valueRecord(value: unknown, actionCase: string): ActionValue {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new TypeError(`computer action ${actionCase} has no value`);
  }
  return value as ActionValue;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`computer action field ${field} is not numeric`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`computer action field ${field} is not textual`);
  }
  return value;
}

function optionalCoordinate(value: unknown): Coordinate | undefined {
  if (value == null) return undefined;
  const record = valueRecord(value, "coordinate");
  return new Coordinate({
    x: requiredNumber(record.x, "coordinate.x"),
    y: requiredNumber(record.y, "coordinate.y"),
  });
}

function button(value: unknown): MouseButton {
  if (typeof value !== "string") {
    throw new TypeError("computer action button is not textual");
  }
  const buttons: Readonly<Record<string, MouseButton>> = {
    LEFT: MouseButton.LEFT,
    RIGHT: MouseButton.RIGHT,
    MIDDLE: MouseButton.MIDDLE,
    BACK: MouseButton.BACK,
    FORWARD: MouseButton.FORWARD,
  };
  const result = buttons[value];
  if (result === undefined) throw new TypeError(`unknown computer action button: ${value}`);
  return result;
}

function direction(value: unknown): ScrollDirection {
  if (typeof value !== "string") {
    throw new TypeError("computer action direction is not textual");
  }
  const directions: Readonly<Record<string, ScrollDirection>> = {
    UP: ScrollDirection.UP,
    DOWN: ScrollDirection.DOWN,
    LEFT: ScrollDirection.LEFT,
    RIGHT: ScrollDirection.RIGHT,
  };
  const result = directions[value];
  if (result === undefined) throw new TypeError(`unknown computer action direction: ${value}`);
  return result;
}

function generatedAction(action: ComputerProtocolAction): ComputerUseAction {
  const actionCase = action.action.case;
  if (actionCase === undefined) throw new TypeError("computer action has no case");
  const value = valueRecord(action.action.value, actionCase);
  switch (actionCase) {
    case "mouseMove":
      {
        const coordinate = optionalCoordinate(value.coordinate);
      return new ComputerUseAction({
        action: {
          case: "mouseMove",
          value: new MouseMoveAction({
            ...(coordinate === undefined ? {} : { coordinate }),
          }),
        },
      });
      }
    case "click":
      {
        const coordinate = optionalCoordinate(value.coordinate);
      return new ComputerUseAction({
        action: {
          case: "click",
          value: new ClickAction({
            ...(coordinate === undefined ? {} : { coordinate }),
            button: button(value.button),
            count: requiredNumber(value.count, "count"),
            ...(value.modifierKeys == null ? {} : { modifierKeys: requiredString(value.modifierKeys, "modifierKeys") }),
          }),
        },
      });
      }
    case "mouseDown":
      return new ComputerUseAction({ action: { case: "mouseDown", value: new MouseDownAction({ button: button(value.button) }) } });
    case "mouseUp":
      return new ComputerUseAction({ action: { case: "mouseUp", value: new MouseUpAction({ button: button(value.button) }) } });
    case "drag": {
      if (!Array.isArray(value.path)) throw new TypeError("computer action drag path is not an array");
      const path = value.path.map(point => {
        const coordinate = optionalCoordinate(point);
        if (coordinate === undefined) throw new TypeError("computer action drag path contains no coordinate");
        return coordinate;
      });
      return new ComputerUseAction({
        action: {
          case: "drag",
          value: new DragAction({
            path,
            button: button(value.button),
            ...(value.modifierKeys == null ? {} : { modifierKeys: requiredString(value.modifierKeys, "modifierKeys") }),
          }),
        },
      });
    }
    case "scroll":
      {
        const coordinate = optionalCoordinate(value.coordinate);
      return new ComputerUseAction({
        action: {
          case: "scroll",
          value: new ScrollAction({
            ...(coordinate === undefined ? {} : { coordinate }),
            direction: direction(value.direction),
            amount: requiredNumber(value.amount, "amount"),
            ...(value.modifierKeys == null ? {} : { modifierKeys: requiredString(value.modifierKeys, "modifierKeys") }),
          }),
        },
      });
      }
    case "type":
      return new ComputerUseAction({ action: { case: "type", value: new TypeAction({ text: requiredString(value.text, "text") }) } });
    case "key":
      return new ComputerUseAction({
        action: {
          case: "key",
          value: new KeyAction({
            key: requiredString(value.key, "key"),
            ...(value.holdDurationMs == null ? {} : { holdDurationMs: requiredNumber(value.holdDurationMs, "holdDurationMs") }),
          }),
        },
      });
    case "wait":
      return new ComputerUseAction({ action: { case: "wait", value: new WaitAction({ durationMs: requiredNumber(value.durationMs, "durationMs") }) } });
    case "screenshot":
      return new ComputerUseAction({ action: { case: "screenshot", value: new ScreenshotAction({}) } });
    case "cursorPosition":
      return new ComputerUseAction({ action: { case: "cursorPosition", value: new CursorPositionAction({}) } });
    default:
      throw new TypeError(`unsupported computer action: ${actionCase}`);
  }
}

export function toGeneratedComputerUseArgs(args: {
  readonly toolCallId: string;
  readonly actions: readonly ComputerProtocolAction[];
  readonly bindUnmappedCharacters?: boolean;
  readonly description?: string;
}): ComputerUseArgs {
  return new ComputerUseArgs({
    toolCallId: args.toolCallId,
    actions: args.actions.map(generatedAction),
    ...(args.bindUnmappedCharacters === undefined ? {} : { bindUnmappedCharacters: args.bindUnmappedCharacters }),
    ...(args.description === undefined ? {} : { description: args.description }),
  });
}

function fromGeneratedComputerUseResult(result: GeneratedComputerUseResult): ComputerUseResult {
  if (result.result.case === "success") {
    const value = result.result.value;
    return {
      result: {
        case: "success",
        value: {
          ...(value.screenshot === undefined ? {} : { screenshot: value.screenshot }),
          ...(value.cursorPosition === undefined ? {} : { cursorPosition: { x: value.cursorPosition.x, y: value.cursorPosition.y } }),
        },
      },
    };
  }
  if (result.result.case === "error") {
    return { result: { case: "error", value: { error: result.result.value.error } } };
  }
  return { result: { case: "" } };
}

/**
 * Projects the real per-turn remote executor and, when enabled, the live
 * generated Auto-review classifier/controller contract into the host tool.
 */
export function createHostComputerToolDependencies<Context = unknown>(
  input: HostComputerToolProjectionInput<Context>,
): ComputerToolDependencies<Context> {
  const executor = input.resourceAccessor.get(computerUseExecutorResource) as Executor<ComputerUseArgs, GeneratedComputerUseResult>;
  return {
    resourceAccessor: input.resourceAccessor,
    async execute(context, args) {
      return fromGeneratedComputerUseResult(await executor.execute(context as never, toGeneratedComputerUseArgs(args)));
    },
    getPersistImage: () => input.persistImage,
    ...(input.isUnicodeTypingEnabled === undefined ? {} : { isUnicodeTypingEnabled: input.isUnicodeTypingEnabled }),
    ...(input.onComputerAction === undefined ? {} : { onComputerAction: input.onComputerAction }),
    ...(input.autoReview === undefined ? {} : { autoReview: input.autoReview }),
  };
}

/**
 * Projects the real box shell resource without inventing approval or audit
 * behavior. Both safety callbacks are mandatory and run before the generated
 * executor receives the caller's context and abort-bearing options.
 */
export function createHostShellExecutor(
  input: HostShellExecutorProjectionInput,
): HostShellExecutor {
  const executor = input.resourceAccessor.get(shellExecutorResource) as Executor<ShellArgs, ShellResult>;
  return {
    async execute(context, args, options?: ExecutorOptions) {
      input.assertNoPendingApproval();
      input.auditShellCommand(args.command);
      return await executor.execute(
        context as Context,
        buildHostShellArgs(args),
        options,
      );
    },
  };
}

/**
 * Projects the immutable browser identity contract. Window readiness is
 * checked before lookup; an unassigned window remains undefined so the
 * browser driver retains its shipped missing-view error. The transcript ID
 * is the default view identity, not a synthetic literal.
 */
export function createHostBrowserDriverDependencies<Context = unknown>(
  input: HostBrowserDriverProjectionInput<Context>,
): BrowserDriverDependencies<Context> {
  return {
    resourceAccessor: input.resourceAccessor,
    async getWindowIndex(context) {
      const boxId = input.getBoxId();
      await input.box.ensureReady(context, boxId);
      return input.box.getAgentWindowIndex(boxId);
    },
    getBoxId: input.getBoxId,
    getDefaultViewId: input.getDefaultViewId,
    async uploadFile(context, boxId, path, bytes) {
      await input.box.uploadFile(context, boxId, path, bytes);
    },
    async downloadFile(context, boxId, path) {
      return await input.box.downloadFile(context, boxId, path);
    },
    async executeShell(context, shellInput) {
      const result = await input.executeShell.execute(context, shellInput);
      if (result.result.case === "success") {
        return {
          case: "success",
          stdout: result.result.value.stdout,
          stderr: result.result.value.stderr,
          exitCode: result.result.value.exitCode,
        };
      }
      return { case: result.result.case ?? "" };
    },
    ...(input.getPersistImage === undefined ? {} : { getPersistImage: input.getPersistImage }),
    ...(input.autoReview === undefined ? {} : { autoReview: input.autoReview }),
  };
}
