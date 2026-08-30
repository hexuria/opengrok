import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { buildHostShellArgs } from "../../box/box-shell-command.js";
import { navigationProbeCommand, normalizeNavigationUrl, parseNavigationProbeOutput } from "../sand-action-audit.js";
import { SAND_BOX_NO_MONITOR_AVAILABLE_MESSAGE } from "../../ports/box.js";
import { shellExecutorResource } from "../../../packages/agent-exec/shell.js";
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../packages/agent-exec/remote.js";
import type { Context as OperationContext } from "../../../packages/context/core.js";
import {
  runSandBrowserAutoReviewPreflight,
  SandBrowserAutoReviewBlockedError,
  type SandBrowserAutoReviewOptions,
} from "../sand-browser-auto-review.js";
import {
  SAND_BROWSER_DRIVER_BOX_DIR,
  SAND_BROWSER_DRIVER_BOX_PATH,
  SAND_BROWSER_DRIVER_SOURCE,
  SAND_BROWSER_RESULT_MARKER,
} from "./sand-browser-driver-source.js";

export const BOX_CDP_PORT_BASE = 9_222;
export const PENDING_SCREENSHOT_CAP = 32;

const pendingScreenshots = new Map<string, string>();

export function stashScreenshot(imageB64: string): string {
  const key = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  if (pendingScreenshots.size >= PENDING_SCREENSHOT_CAP) {
    const oldest = pendingScreenshots.keys().next().value;
    if (oldest !== undefined) pendingScreenshots.delete(oldest);
  }
  pendingScreenshots.set(key, imageB64);
  return key;
}

export interface BrowserEnvelope {
  readonly text: string;
  readonly imageKey?: string;
}

export function encodeEnvelope(envelope: BrowserEnvelope): string {
  return JSON.stringify(envelope);
}

export function decodeEnvelope(raw: string): BrowserEnvelope {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object"
      && parsed !== null
      && "text" in parsed
      && typeof parsed.text === "string"
    ) {
      return {
        text: parsed.text,
        ...(
          "imageKey" in parsed && typeof parsed.imageKey === "string"
            ? { imageKey: parsed.imageKey }
            : {}
        ),
      };
    }
  } catch {}
  return { text: raw };
}

export interface BrowserDriverResponse {
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly summary?: string | undefined;
  readonly data?: string | undefined;
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly viewId?: string | undefined;
  readonly screenshot?: boolean | undefined;
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(
  object: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = object[key];
  return typeof value === "boolean" ? value : undefined;
}

export function toDriverResponse(
  parsed: Record<string, unknown>,
): BrowserDriverResponse {
  return {
    ok: optionalBoolean(parsed, "ok") ?? false,
    ...(optionalString(parsed, "error") == null
      ? {}
      : { error: optionalString(parsed, "error") }),
    ...(optionalString(parsed, "summary") == null
      ? {}
      : { summary: optionalString(parsed, "summary") }),
    ...(optionalString(parsed, "data") == null
      ? {}
      : { data: optionalString(parsed, "data") }),
    ...(optionalString(parsed, "url") == null
      ? {}
      : { url: optionalString(parsed, "url") }),
    ...(optionalString(parsed, "title") == null
      ? {}
      : { title: optionalString(parsed, "title") }),
    ...(optionalString(parsed, "viewId") == null
      ? {}
      : { viewId: optionalString(parsed, "viewId") }),
    ...(optionalBoolean(parsed, "screenshot") == null
      ? {}
      : { screenshot: optionalBoolean(parsed, "screenshot") }),
  };
}

export function parseDriverResponse(
  stdout: string,
): BrowserDriverResponse | undefined {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const markerIndex = line.indexOf(SAND_BROWSER_RESULT_MARKER);
    if (markerIndex < 0) continue;
    try {
      const parsed: unknown = JSON.parse(
        line.slice(markerIndex + SAND_BROWSER_RESULT_MARKER.length),
      );
      if (
        typeof parsed === "object"
        && parsed !== null
        && !Array.isArray(parsed)
      ) {
        return toDriverResponse(parsed as Record<string, unknown>);
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sanitizeForBoxPath(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return cleaned.length > 0 ? cleaned : `call-${Date.now()}`;
}

export class SandBrowserDriverError extends Error {
  override readonly name = "SandBrowserDriverError";
}

export interface BrowserDriverDependencies<Context> {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  getWindowIndex(context: Context): Promise<number | undefined>;
  getBoxId(): string;
  getDefaultViewId(): string;
  uploadFile(
    context: Context,
    boxId: string,
    path: string,
    bytes: Uint8Array,
  ): Promise<void>;
  downloadFile(
    context: Context,
    boxId: string,
    path: string,
  ): Promise<Uint8Array>;
  executeShell(
    context: Context,
    input: {
      command: string;
      name: string;
      workingDirectory: string;
      toolCallId: string;
    },
  ): Promise<{
    readonly case: "success" | string;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
  }>;
  getPersistImage?():
    | ((bytes: Uint8Array, mimeType: string) => Promise<unknown>)
    | undefined;
  readonly autoReview?: SandBrowserAutoReviewOptions;
}

export interface BrowserDriverOutput {
  readonly text: string;
  readonly imageB64?: string;
  readonly isError?: boolean;
}

export class SandBrowserDriver<Context = unknown> {
  #uploaded: Promise<void> | undefined;
  #windowIndex: Promise<number> | undefined;

  constructor(readonly dependencies: BrowserDriverDependencies<Context>) {}

  resolveWindowIndex(context: Context): Promise<number> {
    this.#windowIndex ??= this.dependencies.getWindowIndex(context)
      .then((index) => {
        if (index === undefined) {
          this.#windowIndex = undefined;
          throw new SandBrowserDriverError(
            "The box has not assigned this agent a browser window yet; try again in a moment.",
          );
        }
        return index;
      })
      .catch((error: unknown) => {
        this.#windowIndex = undefined;
        throw error instanceof SandBrowserDriverError
          ? error
          : new SandBrowserDriverError(
            `Could not resolve this agent's browser window: ${error instanceof Error ? error.message : String(error)}`,
          );
      });
    return this.#windowIndex;
  }

  ensureUploaded(context: Context): Promise<void> {
    this.#uploaded ??= this.dependencies.uploadFile(
      context,
      this.dependencies.getBoxId(),
      SAND_BROWSER_DRIVER_BOX_PATH,
      Buffer.from(SAND_BROWSER_DRIVER_SOURCE, "utf8"),
    ).catch((error: unknown) => {
      this.#uploaded = undefined;
      throw new SandBrowserDriverError(
        `Could not install the browser driver on the box: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return this.#uploaded;
  }

  async run(
    context: Context,
    input: {
      readonly op: string;
      readonly toolCallId: string;
      readonly args: Record<string, unknown>;
      readonly skipScreenshot?: boolean;
    },
  ): Promise<BrowserDriverOutput> {
    const [windowIndex] = await Promise.all([
      this.resolveWindowIndex(context),
      this.ensureUploaded(context),
    ]);

    const screenshotPath = input.skipScreenshot === true
      ? undefined
      : `${SAND_BROWSER_DRIVER_BOX_DIR}/shot-${sanitizeForBoxPath(input.toolCallId)}.png`;
    const requestedViewId = input.args.viewId;
    const request = {
      ...input.args,
      op: input.op,
      display: windowIndex,
      cdpPort: BOX_CDP_PORT_BASE + windowIndex,
      viewId: typeof requestedViewId === "string" && requestedViewId.length > 0
        ? requestedViewId
        : this.dependencies.getDefaultViewId(),
      ...(screenshotPath == null ? {} : { screenshotPath }),
    };
    const encoded = Buffer.from(
      JSON.stringify(request),
      "utf8",
    ).toString("base64");

    const shell = await this.dependencies.executeShell(context, {
      command: `node ${SAND_BROWSER_DRIVER_BOX_PATH} ${encoded}`,
      name: "node",
      workingDirectory: "/workspace",
      toolCallId: `sand-browser-${input.op}-${sanitizeForBoxPath(input.toolCallId)}`,
    });
    if (shell.case !== "success") {
      throw new SandBrowserDriverError(
        `Browser driver shell failed (${shell.case || "unknown"})`,
      );
    }

    const response = parseDriverResponse(shell.stdout ?? "");
    if (response === undefined) {
      const detail = [shell.stderr ?? "", shell.stdout ?? ""]
        .map((part) => part.trim().slice(-400))
        .filter((part) => part.length > 0)
        .join(" | ");
      throw new SandBrowserDriverError(
        `Browser driver produced no result (exit ${shell.exitCode ?? "unknown"})${detail.length > 0 ? `: ${detail}` : ""}`,
      );
    }
    if (!response.ok) {
      return {
        text: response.error ?? "The browser action failed.",
        isError: true,
      };
    }

    const parts = [response.summary ?? "Done."];
    if (response.url != null && response.url.length > 0) {
      parts.push(`Current page: ${response.title ?? ""} (${response.url})`);
    }
    if (response.data != null && response.data.length > 0) {
      parts.push(response.data);
    }

    const imageB64 = response.screenshot === true && screenshotPath != null
      ? await this.fetchScreenshot(context, screenshotPath)
      : undefined;
    return {
      text: parts.join("\n\n"),
      ...(imageB64 == null ? {} : { imageB64 }),
    };
  }

  async fetchScreenshot(
    context: Context,
    boxPath: string,
  ): Promise<string | undefined> {
    try {
      const bytes = await this.dependencies.downloadFile(
        context,
        this.dependencies.getBoxId(),
        boxPath,
      );
      if (bytes.length === 0) return undefined;
      const persistImage = this.dependencies.getPersistImage?.();
      if (persistImage != null) {
        await persistImage(bytes, "image/png").catch(() => null);
      }
      return Buffer.from(bytes).toString("base64");
    } catch {
      return undefined;
    }
  }
}

export interface BrowserReviewAction {
  readonly [key: string]: unknown;
  readonly op: string;
  readonly viewId: string;
  readonly url?: string | undefined;
  readonly ref?: string | undefined;
  readonly element?: string | undefined;
  readonly text?: string | undefined;
  readonly value?: string | undefined;
  readonly values?: readonly string[] | undefined;
  readonly key?: string | undefined;
  readonly cdpMethod?: string | undefined;
  readonly cdpParams?: string | undefined;
  readonly tabsAction?: string | undefined;
  readonly tabIndex?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly sourceRef?: string | undefined;
  readonly targetRef?: string | undefined;
  readonly targetX?: number | undefined;
  readonly targetY?: number | undefined;
  readonly newTab?: boolean | undefined;
  readonly submit?: boolean | undefined;
  readonly clear?: boolean | undefined;
  readonly doubleClick?: boolean | undefined;
  readonly button?: string | undefined;
  readonly modifiers?: readonly string[] | undefined;
}

const BROWSER_REVIEW_STATE_MARKER = "__SAND_BROWSER_VIEW_STATE__";

function resolveBrowserTargetPageUrl(
  probeStdout: string,
  stateJson: string,
  viewId: string,
): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(stateJson); } catch { parsed = undefined; }
  const fields = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const views = fields.views !== null && typeof fields.views === "object" && !Array.isArray(fields.views)
    ? fields.views as Record<string, unknown>
    : {};
  const urls = fields.urls !== null && typeof fields.urls === "object" && !Array.isArray(fields.urls)
    ? fields.urls as Record<string, unknown>
    : {};
  const targetId = views[viewId];
  if (typeof targetId === "string" && targetId.length > 0) {
    const target = parseNavigationProbeOutput(probeStdout).find(candidate => candidate.type === "page" && candidate.id === targetId);
    const url = typeof target?.url === "string" ? normalizeNavigationUrl(target.url) : undefined;
    if (url !== undefined) return url;
  }
  return typeof urls[viewId] === "string" ? normalizeNavigationUrl(urls[viewId] as string) : undefined;
}

async function captureBrowserReviewState(args: {
  readonly ctx: OperationContext;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly toolCallId: string;
  readonly resolveDisplayNumber: (ctx: OperationContext) => Promise<number | undefined>;
  readonly viewId?: string;
}): Promise<{ displayStateIdentity: string; targetPageUrl?: string }> {
  let displayNumber: number | undefined;
  try { displayNumber = await args.resolveDisplayNumber(args.ctx); } catch {
    throw new SandBrowserAutoReviewBlockedError("Browser Auto-review could not identify this agent's own display; retry once the box desktop is ready.");
  }
  if (displayNumber === undefined) throw new SandBrowserAutoReviewBlockedError(SAND_BOX_NO_MONITOR_AVAILABLE_MESSAGE);
  let result: any;
  try {
    result = await (args.resourceAccessor.get(shellExecutorResource) as { execute(ctx: OperationContext, args: unknown): Promise<any> }).execute(args.ctx, buildHostShellArgs({
      command: `${navigationProbeCommand(displayNumber)} && echo ${BROWSER_REVIEW_STATE_MARKER} && (cat ${SAND_BROWSER_DRIVER_BOX_DIR}/views-${displayNumber}.json 2>/dev/null || true)`,
      name: "curl",
      workingDirectory: "/workspace",
      toolCallId: `${args.toolCallId}:auto-review-state`,
    }));
  } catch {
    throw new SandBrowserAutoReviewBlockedError("Browser Auto-review could not capture the current page state.");
  }
  if (result?.result?.case !== "success") throw new SandBrowserAutoReviewBlockedError("Browser Auto-review could not capture the current page state.");
  if (result.result.value.exitCode !== 0) return { displayStateIdentity: "chrome-unreachable" };
  const stdout = result.result.value.stdout ?? "";
  const markerIndex = stdout.indexOf(BROWSER_REVIEW_STATE_MARKER);
  const probePart = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
  const statePart = markerIndex >= 0 ? stdout.slice(markerIndex + BROWSER_REVIEW_STATE_MARKER.length) : "";
  const targetPageUrl = args.viewId === undefined ? undefined : resolveBrowserTargetPageUrl(probePart, statePart.trim(), args.viewId);
  const pageIdentity = parseNavigationProbeOutput(probePart)
    .filter(target => target.type === "page" && typeof target.id === "string")
    .map(target => `${String(target.id)}\t${typeof target.url === "string" ? String(target.url).trim() : ""}`)
    .sort()
    .join("\n");
  return {
    displayStateIdentity: createHash("sha256").update(pageIdentity).digest("hex"),
    ...(targetPageUrl === undefined ? {} : { targetPageUrl }),
  };
}

export function toBrowserReviewAction(
  op: string,
  args: Record<string, unknown>,
  defaultViewId: string,
): BrowserReviewAction {
  const stringValue = (key: string): string | undefined =>
    typeof args[key] === "string" ? args[key] : undefined;
  const numberValue = (key: string): number | undefined =>
    typeof args[key] === "number" ? args[key] : undefined;
  const booleanValue = (key: string): boolean | undefined =>
    typeof args[key] === "boolean" ? args[key] : undefined;
  const stringArray = (key: string): string[] | undefined =>
    Array.isArray(args[key])
      ? args[key].filter((entry): entry is string => typeof entry === "string")
      : undefined;

  return {
    op,
    viewId: stringValue("viewId") ?? defaultViewId,
    ...(stringValue("url") == null ? {} : { url: stringValue("url") }),
    ...(stringValue("ref") == null ? {} : { ref: stringValue("ref") }),
    ...(stringValue("element") == null ? {} : { element: stringValue("element") }),
    ...(stringValue("text") == null ? {} : { text: stringValue("text") }),
    ...(stringValue("value") == null ? {} : { value: stringValue("value") }),
    ...(stringArray("values") == null ? {} : { values: stringArray("values") }),
    ...(stringValue("key") == null ? {} : { key: stringValue("key") }),
    ...(op !== "cdp" || stringValue("method") == null
      ? {}
      : { cdpMethod: stringValue("method") }),
    ...(op !== "cdp" || args.params === undefined
      ? {}
      : { cdpParams: JSON.stringify(args.params) }),
    ...(op !== "tabs" || stringValue("action") == null
      ? {}
      : { tabsAction: stringValue("action") }),
    ...(op !== "tabs" || numberValue("index") == null
      ? {}
      : { tabIndex: numberValue("index") }),
    ...(numberValue("x") == null ? {} : { x: numberValue("x") }),
    ...(numberValue("y") == null ? {} : { y: numberValue("y") }),
    ...(stringValue("sourceRef") == null
      ? {}
      : { sourceRef: stringValue("sourceRef") }),
    ...(stringValue("targetRef") == null
      ? {}
      : { targetRef: stringValue("targetRef") }),
    ...(numberValue("targetX") == null
      ? {}
      : { targetX: numberValue("targetX") }),
    ...(numberValue("targetY") == null
      ? {}
      : { targetY: numberValue("targetY") }),
    ...(booleanValue("newTab") == null
      ? {}
      : { newTab: booleanValue("newTab") }),
    ...(booleanValue("submit") == null
      ? {}
      : { submit: booleanValue("submit") }),
    ...(booleanValue("clear") == null
      ? {}
      : { clear: booleanValue("clear") }),
    ...(booleanValue("doubleClick") == null
      ? {}
      : { doubleClick: booleanValue("doubleClick") }),
    ...(stringValue("button") == null
      ? {}
      : { button: stringValue("button") }),
    ...(stringArray("modifiers") == null
      ? {}
      : { modifiers: stringArray("modifiers") }),
  };
}

export interface BrowserToolSchema {
  readonly required?: readonly string[];
  readonly enum?: Readonly<Record<string, readonly string[]>>;
}

export interface BrowserToolDefinition<Context> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly op: string;
  readonly schema: BrowserToolSchema;
  readonly canNavigate?: boolean;
  readonly skipScreenshot?: boolean;
  execute(
    context: Context,
    args: Record<string, unknown>,
    metadata: { readonly toolCallId: string; readonly stateHandler?: unknown; readonly workspacePaths?: readonly string[] },
  ): Promise<BrowserDriverOutput>;
  render(output: BrowserDriverOutput): {
    readonly kind: "text" | "image";
    readonly text: string;
    readonly imageB64?: string;
    readonly isError?: boolean;
  };
}

interface BrowserToolSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly op: string;
  readonly schema?: BrowserToolSchema;
  readonly canNavigate?: boolean;
  readonly skipScreenshot?: boolean;
}

const BROWSER_TOOL_SPECS: readonly BrowserToolSpec[] = [
  { id: "BROWSER_NAVIGATE", name: "browser_navigate", op: "navigate", description: "Navigate the box browser to a URL. By default reuses your tab; set newTab: true to open in a new tab. Returns the resulting page state with a screenshot.", schema: { required: ["url"] }, canNavigate: true },
  { id: "BROWSER_SNAPSHOT", name: "browser_snapshot", op: "snapshot", description: "Capture a structured snapshot of the current page with [ref=eN] handles for interactive elements. This is the source of truth for page structure; refs are tied to the latest snapshot for that tab. Better than a screenshot for deciding what to click or type." },
  { id: "BROWSER_CLICK", name: "browser_click", op: "click", description: "Click an element by ref from browser_snapshot. Scrolls the element into view first.", schema: { required: ["ref"] }, canNavigate: true },
  { id: "BROWSER_MOUSE_CLICK_XY", name: "browser_mouse_click_xy", op: "mouse_click_xy", description: "Click at viewport coordinates. Prefer browser_click with refs when possible.", schema: { required: ["x", "y"] }, canNavigate: true },
  { id: "BROWSER_TYPE", name: "browser_type", op: "type", description: "Type text into an input, textarea, or contenteditable element by ref.", schema: { required: ["ref", "text"] }, canNavigate: true },
  { id: "BROWSER_FILL", name: "browser_fill", op: "fill", description: "Set the value of an input, textarea, or contenteditable element by ref.", schema: { required: ["ref", "value"] } },
  { id: "BROWSER_SELECT_OPTION", name: "browser_select_option", op: "select_option", description: "Select one or more options in a select element by ref.", schema: { required: ["ref", "values"] } },
  { id: "BROWSER_PRESS_KEY", name: "browser_press_key", op: "press_key", description: "Press a key in the browser page, for example Enter, Escape, Tab, ArrowDown, or a single character.", schema: { required: ["key"] }, canNavigate: true },
  { id: "BROWSER_SCROLL", name: "browser_scroll", op: "scroll", description: "Scroll the page or scroll an element into view (pass its ref)." },
  { id: "BROWSER_DRAG", name: "browser_drag", op: "drag", description: "Drag an element by ref to another ref or viewport coordinates.", schema: { required: ["sourceRef"] } },
  { id: "BROWSER_GET_BOUNDING_BOX", name: "browser_get_bounding_box", op: "get_bounding_box", description: "Get the viewport bounding box for an element ref.", schema: { required: ["ref"] }, skipScreenshot: true },
  { id: "BROWSER_HIGHLIGHT", name: "browser_highlight", op: "highlight", description: "Highlight an element by ref in the browser page for visual grounding. The returned screenshot shows the highlight.", schema: { required: ["ref"] } },
  { id: "BROWSER_CDP", name: "browser_cdp", op: "cdp", description: "Send a Chrome DevTools Protocol command to the target browser tab. Do not use CDP Input.* methods; use dedicated browser tools for clicks, text input, key presses, scrolling, and drag-and-drop. Browser-wide, storage, cookie, cache, permission, and target-management commands are denied.", schema: { required: ["method"] }, canNavigate: true },
  { id: "BROWSER_TABS", name: "browser_tabs", op: "tabs", description: "List, create, close, or select a browser tab.", schema: { required: ["action"], enum: { action: ["list", "new", "close", "select"] } }, skipScreenshot: true },
  { id: "BROWSER_TAKE_SCREENSHOT", name: "browser_take_screenshot", op: "screenshot", description: "Take a screenshot of the current page. Usually redundant: every browser action already returns one. Use fullPage for the full scrollable page." },
];

function validateArguments(
  schema: BrowserToolSchema,
  args: Record<string, unknown>,
): void {
  for (const key of schema.required ?? []) {
    if (args[key] == null || args[key] === "") {
      throw new SandBrowserDriverError(`${key} is required`);
    }
  }
  for (const [key, values] of Object.entries(schema.enum ?? {})) {
    if (typeof args[key] !== "string" || !values.includes(args[key])) {
      throw new SandBrowserDriverError(
        `${key} must be one of ${values.join(", ")}`,
      );
    }
  }
}

export function createSandBrowserTools<Context>(
  dependencies: BrowserDriverDependencies<Context> & {
    readonly onPossibleNavigation?: (context: Context) => void;
  },
): BrowserToolDefinition<Context>[] {
  const driver = new SandBrowserDriver(dependencies);
  return BROWSER_TOOL_SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    op: spec.op,
    schema: spec.schema ?? {},
    ...(spec.canNavigate === true ? { canNavigate: true } : {}),
    ...(spec.skipScreenshot === true ? { skipScreenshot: true } : {}),
    async execute(context, args, metadata) {
      try {
        validateArguments(spec.schema ?? {}, args);
        if (dependencies.autoReview !== undefined) {
          const exactAction = toBrowserReviewAction(spec.op, args, dependencies.getDefaultViewId());
          await runSandBrowserAutoReviewPreflight({
            ctx: context as unknown as OperationContext,
            resourceAccessor: dependencies.resourceAccessor as ResourceAccessor<RemoteExecManager>,
            options: {
              ...dependencies.autoReview,
              captureReviewState: (stateCtx, stateToolCallId) => captureBrowserReviewState({
                ctx: stateCtx,
                resourceAccessor: dependencies.resourceAccessor as ResourceAccessor<RemoteExecManager>,
                toolCallId: stateToolCallId,
                resolveDisplayNumber: dependencies.autoReview!.resolveDisplayNumber,
                ...(spec.op !== "tabs" && exactAction.viewId === undefined ? {} : { viewId: exactAction.viewId }),
              }),
            },
            exactAction,
            toolCallId: metadata.toolCallId,
            ...(metadata.stateHandler === undefined ? {} : { stateHandler: metadata.stateHandler }),
            ...(metadata.workspacePaths === undefined ? {} : { workspacePaths: metadata.workspacePaths }),
          });
        }
        const output = await driver.run(context, {
          op: spec.op,
          toolCallId: metadata.toolCallId,
          args,
          ...(spec.skipScreenshot === undefined
            ? {}
            : { skipScreenshot: spec.skipScreenshot }),
        });
        if (spec.canNavigate === true && output.isError !== true) {
          dependencies.onPossibleNavigation?.(context);
        }
        return output;
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
    render(output) {
      if (output.imageB64 != null && output.imageB64.length > 0) {
        const key = stashScreenshot(output.imageB64);
        const image = pendingScreenshots.get(key);
        pendingScreenshots.delete(key);
        return {
          kind: "image",
          text: output.text,
          ...(image == null ? {} : { imageB64: image }),
          ...(output.isError === true ? { isError: true } : {}),
        };
      }
      return {
        kind: "text",
        text: output.text,
        ...(output.isError === true ? { isError: true } : {}),
      };
    },
  }));
}
