import { Buffer } from "node:buffer";
import { buildHostShellArgs } from "../../box/box-shell-command.js";
import { navigationProbeCommand } from "../sand-action-audit.js";
import { SAND_BOX_NO_MONITOR_AVAILABLE_MESSAGE } from "../../ports/box.js";
import { shellExecutorResource } from "../../../packages/agent-exec/shell.js";
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../packages/agent-exec/remote.js";
import type { Context } from "../../../packages/context/core.js";
import { z } from "zod";
import {
  isSandComputerAutoReviewBypassAction,
  runSandComputerAutoReviewPreflight,
  SAND_COMPUTER_PAGE_STATE_CHROME_UNREACHABLE,
  computeSandComputerPageStateIdentity,
  SandComputerAutoReviewBlockedError,
  type SandComputerAutoReviewOptions,
  type BoxIdentity,
} from "../sand-computer-auto-review.js";
import type { SandAutoReviewMode } from "../sand-auto-review.js";
import { SandToolInputError } from "./tool-input-error.js";

export const MOUSE_BUTTONS = { left: "LEFT", right: "RIGHT", middle: "MIDDLE" } as const;
export const SCROLL_DIRECTIONS = { up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT" } as const;
export const SAND_COMPUTER_MAX_WAIT_MS = 30_000;
export const SAND_COMPUTER_MAX_FOLLOW_UP_ACTIONS = 9;
export const COMPUTER_ACTIONS = ["screenshot", "click", "move", "drag", "type", "key", "scroll", "wait"] as const;
export type ComputerActionName = typeof COMPUTER_ACTIONS[number];

export interface ComputerActionArgs {
  readonly [key: string]: unknown;
  readonly action: ComputerActionName;
  readonly x?: number;
  readonly y?: number;
  readonly x2?: number;
  readonly y2?: number;
  readonly path?: readonly { readonly x: number; readonly y: number }[];
  readonly text?: string;
  readonly key?: string;
  readonly button?: keyof typeof MOUSE_BUTTONS;
  readonly count?: number;
  readonly direction?: keyof typeof SCROLL_DIRECTIONS;
  readonly amount?: number;
  readonly durationMs?: number;
  readonly description?: string;
  readonly then?: readonly ComputerActionArgs[];
}

const actionCoreShape = {
  action: z.enum(COMPUTER_ACTIONS),
  x: z.number().int().optional(), y: z.number().int().optional(),
  x2: z.number().int().optional(), y2: z.number().int().optional(),
  path: z.array(z.object({ x: z.number().int(), y: z.number().int() })).optional(),
  text: z.string().optional(), key: z.string().optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  count: z.number().int().min(1).max(3).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.number().int().optional(),
  durationMs: z.number().int().min(0).max(SAND_COMPUTER_MAX_WAIT_MS).optional(),
};

function validateAction(args: z.infer<z.ZodObject<typeof actionCoreShape>>, ctx: z.RefinementCtx): void {
  if (args.action === "drag" && !(args.path != null && args.path.length >= 2)
    && (args.x == null || args.y == null || args.x2 == null || args.y2 == null)) {
    ctx.addIssue({ code: "custom", message: "Drag requires x, y, x2, and y2 or a path with at least 2 points." });
  }
}

export function buildComputerActionCoreSchema(actions: readonly [ComputerActionName, ...ComputerActionName[]] = COMPUTER_ACTIONS) {
  return z.object({ ...actionCoreShape, action: z.enum(actions) }).superRefine(validateAction);
}

const FOLLOW_UP_ACTIONS = COMPUTER_ACTIONS.filter((action) => action !== "screenshot") as [ComputerActionName, ...ComputerActionName[]];
const REVIEWABLE_FOLLOW_UP_ACTIONS = FOLLOW_UP_ACTIONS.filter(isSandComputerAutoReviewBypassAction) as [ComputerActionName, ...ComputerActionName[]];

export function buildComputerParameters(autoReview?: { readonly mode: SandAutoReviewMode }) {
  const allowed = autoReview?.mode === "enforce" ? REVIEWABLE_FOLLOW_UP_ACTIONS : FOLLOW_UP_ACTIONS;
  return z.object({
    ...actionCoreShape,
    then: z.array(buildComputerActionCoreSchema(allowed)).min(1).max(SAND_COMPUTER_MAX_FOLLOW_UP_ACTIONS).optional(),
    description: z.string().optional(),
  }).superRefine((args, ctx) => {
    validateAction(args, ctx);
    if (autoReview?.mode === "enforce" && (args.action === "click" || args.action === "drag") && !args.description?.trim()) {
      ctx.addIssue({ code: "custom", path: ["description"], message: "Click and drag require description: a concise statement of the intended UI target and purpose." });
    }
  });
}

export const computerActionParameters = buildComputerParameters();
export const screenshotParameters = z.object({});

export function toExactActionArgs(args: ComputerActionArgs): ComputerActionArgs {
  const { description: _description, then: _then, ...exact } = args;
  return exact;
}

export function dragPath(args: ComputerActionArgs): readonly { x: number; y: number }[] | undefined {
  if (args.path != null && args.path.length >= 2) return args.path;
  if (args.x == null || args.y == null || args.x2 == null || args.y2 == null) return undefined;
  return [{ x: args.x, y: args.y }, { x: args.x2, y: args.y2 }];
}

export interface ComputerProtocolAction {
  readonly action: { readonly case: string; readonly value: Readonly<Record<string, unknown>> };
}

function coordinate(x: number | undefined, y: number | undefined): { x: number; y: number } | undefined {
  return x == null || y == null ? undefined : { x, y };
}

export function toAction(args: ComputerActionArgs): ComputerProtocolAction {
  switch (args.action) {
    case "screenshot": return { action: { case: "screenshot", value: {} } };
    case "click": return { action: { case: "click", value: {
      ...(coordinate(args.x, args.y) == null ? {} : { coordinate: coordinate(args.x, args.y) }),
      button: MOUSE_BUTTONS[args.button ?? "left"], count: args.count ?? 1,
    } } };
    case "move": return { action: { case: "mouseMove", value: {
      ...(coordinate(args.x, args.y) == null ? {} : { coordinate: coordinate(args.x, args.y) }),
    } } };
    case "drag": {
      const path = dragPath(args);
      if (path == null) throw new SandToolInputError("Drag requires x, y, x2, and y2 or a path with at least 2 points.");
      return { action: { case: "drag", value: { path, button: MOUSE_BUTTONS[args.button ?? "left"] } } };
    }
    case "type": return { action: { case: "type", value: { text: args.text ?? "" } } };
    case "key": return { action: { case: "key", value: { key: args.key ?? "" } } };
    case "scroll": return { action: { case: "scroll", value: {
      ...(coordinate(args.x, args.y) == null ? {} : { coordinate: coordinate(args.x, args.y) }),
      direction: SCROLL_DIRECTIONS[args.direction ?? "down"], amount: args.amount ?? 3,
    } } };
    case "wait": return { action: { case: "wait", value: { durationMs: args.durationMs ?? 1_000 } } };
  }
}

export type ReportedComputerAction =
  | { readonly type: "drag" | "move" | "scroll"; readonly x: number; readonly y: number }
  | { readonly type: "click"; readonly x: number; readonly y: number; readonly button: string; readonly count: number };

export function toReportedAction(args: ComputerActionArgs): ReportedComputerAction | undefined {
  if (args.action === "drag") {
    const first = dragPath(args)?.[0];
    return first == null ? undefined : { type: "drag", x: first.x, y: first.y };
  }
  if (args.action === "move" || args.action === "scroll") {
    return args.x == null || args.y == null ? undefined : { type: args.action, x: args.x, y: args.y };
  }
  if (args.action === "click") {
    return args.x == null || args.y == null ? undefined : {
      type: "click", x: args.x, y: args.y, button: args.button ?? "left", count: args.count ?? 1,
    };
  }
  return undefined;
}

export function reportedBatchPosition(sequence: readonly ComputerActionArgs[]): ReportedComputerAction | undefined {
  const positions = sequence.flatMap((args) => toReportedAction(args) ?? []);
  return positions.find((position) => position.type !== "drag") ?? positions[0];
}

export interface ComputerUseSuccess {
  readonly screenshot?: string;
  screenshotPath?: string;
  readonly cursorPosition?: { readonly x: number; readonly y: number };
}
export type ComputerUseResult =
  | { readonly result: { readonly case: "success"; readonly value: ComputerUseSuccess } }
  | { readonly result: { readonly case: "error"; readonly value: { readonly error: string } } }
  | { readonly result: { readonly case: string; readonly value?: unknown } };

export function describeOutcome(result: ComputerUseResult, operation: "screenshot" | "computer"): string {
  if (result.result.case === "error") return `${operation === "screenshot" ? "Screenshot" : "Computer action"} failed: ${(result.result.value as { error: string }).error}`;
  const heading = operation === "screenshot" ? "Screenshot captured from the box desktop." : "Computer action ran on the box desktop.";
  if (result.result.case !== "success") return heading;
  const value = result.result.value as ComputerUseSuccess;
  const lines = [heading];
  if (value.screenshotPath != null && value.screenshotPath.length > 0) lines.push(`Screenshot saved to ${value.screenshotPath}.`);
  if (value.cursorPosition != null) lines.push(`Cursor is at (${value.cursorPosition.x}, ${value.cursorPosition.y}).`);
  return lines.join("\n");
}

export interface ComputerToolDependencies<Context = unknown> {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  execute(context: Context, args: { readonly toolCallId: string; readonly actions: readonly ComputerProtocolAction[]; readonly bindUnmappedCharacters?: boolean; readonly description?: string }): Promise<ComputerUseResult>;
  getPersistImage(): ((bytes: Uint8Array, mimeType: string) => Promise<{ readonly fileUrl: string } | undefined>) | undefined;
  isUnicodeTypingEnabled?(): boolean;
  onComputerAction?(action: ReportedComputerAction): void;
  autoReview?: SandComputerAutoReviewOptions;
}

async function captureComputerDisplayStateIdentity(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  toolCallId: string,
  resolveDisplayNumber: (ctx: Context) => Promise<number | undefined>,
): Promise<string> {
  let displayNumber: number | undefined;
  try {
    displayNumber = await resolveDisplayNumber(ctx);
  } catch {
    throw new SandComputerAutoReviewBlockedError(
      "Computer Auto-review could not identify this agent's own display; retry once the box desktop is ready.",
    );
  }
  if (displayNumber === undefined) throw new SandComputerAutoReviewBlockedError(SAND_BOX_NO_MONITOR_AVAILABLE_MESSAGE);
  let result: any;
  try {
    result = await (resourceAccessor.get(shellExecutorResource) as { execute(ctx: Context, args: unknown): Promise<any> }).execute(
      ctx,
      buildHostShellArgs({
        command: navigationProbeCommand(displayNumber),
        name: "curl",
        workingDirectory: "/workspace",
        toolCallId: `${toolCallId}:auto-review-state`,
      }),
    );
  } catch {
    throw new SandComputerAutoReviewBlockedError("Computer Auto-review could not capture the current page state.");
  }
  if (result?.result?.case !== "success") throw new SandComputerAutoReviewBlockedError("Computer Auto-review could not capture the current page state.");
  if (result.result.value.exitCode !== 0) return SAND_COMPUTER_PAGE_STATE_CHROME_UNREACHABLE;
  return computeSandComputerPageStateIdentity(result.result.value.stdout ?? "");
}

export async function executeAndPersistComputerUse<Context>(context: Context, deps: ComputerToolDependencies<Context>, args: Parameters<ComputerToolDependencies<Context>["execute"]>[1]): Promise<ComputerUseResult> {
  const result = await deps.execute(context, args);
  if (result.result.case === "success") {
    const success = result.result.value as ComputerUseSuccess;
    if (success.screenshot != null && success.screenshot.length > 0) {
      const saved = await deps.getPersistImage()?.(Buffer.from(success.screenshot, "base64"), "image/webp");
      if (saved != null) success.screenshotPath = saved.fileUrl;
    }
  }
  return result;
}

export function createScreenshotTool<Context>(deps: ComputerToolDependencies<Context>) {
  return {
    id: "OPENAI_COMPUTER_USE", name: "Screenshot", parameters: screenshotParameters,
    async execute(_args: Record<string, never>, meta: { context: Context; toolCallId?: string }): Promise<ComputerUseResult> {
      return executeAndPersistComputerUse(meta.context, deps, {
        toolCallId: meta.toolCallId ?? "", actions: [toAction({ action: "screenshot" })],
      });
    },
    render: (output: ComputerUseResult) => ({ content: describeOutcome(output, "screenshot") }),
  };
}

export function createComputerTool<Context>(deps: ComputerToolDependencies<Context>) {
  const parameters = buildComputerParameters(deps.autoReview);
  return {
    id: "OPENAI_COMPUTER_USE", name: "Computer", parameters,
    async execute(raw: unknown, meta: { context: Context; toolCallId?: string; signal?: AbortSignal; stateHandler?: unknown; workspacePaths?: readonly string[] }): Promise<ComputerUseResult> {
      const parsed = parameters.parse(raw) as ComputerActionArgs;
      const { then, ...primary } = parsed;
      const sequence = [primary, ...(then ?? [])];
      const actions = sequence.map(toAction);
      if (sequence.at(-1)?.action !== "screenshot") actions.push(toAction({ action: "screenshot" }));
      if (deps.autoReview != null) {
        await runSandComputerAutoReviewPreflight({
          ctx: meta.context as unknown as import("../../../packages/context/core.js").Context,
          resourceAccessor: deps.resourceAccessor as ResourceAccessor<RemoteExecManager>,
          exactAction: toExactActionArgs(parsed),
          ...(parsed.description == null ? {} : { description: parsed.description }),
          toolCallId: meta.toolCallId ?? "",
          ...(meta.stateHandler === undefined ? {} : { stateHandler: meta.stateHandler }),
          ...(meta.workspacePaths === undefined ? {} : { workspacePaths: meta.workspacePaths }),
          ...(meta.signal == null ? {} : { signal: meta.signal }),
          options: {
            ...deps.autoReview,
            captureDisplayStateIdentity: (ctx, toolCallId) => captureComputerDisplayStateIdentity(
              ctx,
              deps.resourceAccessor as ResourceAccessor<RemoteExecManager>,
              toolCallId,
              deps.autoReview!.resolveDisplayNumber,
            ),
          },
        });
      }
      const reported = reportedBatchPosition(sequence);
      if (reported != null) deps.onComputerAction?.(reported);
      const description = parsed.description?.trim();
      return executeAndPersistComputerUse(meta.context, deps, {
        toolCallId: meta.toolCallId ?? "", actions,
        ...(deps.isUnicodeTypingEnabled?.() === true ? { bindUnmappedCharacters: true } : {}),
        ...(description == null || description.length === 0 ? {} : { description }),
      });
    },
    render: (output: ComputerUseResult) => ({ content: describeOutcome(output, "computer") }),
  };
}
