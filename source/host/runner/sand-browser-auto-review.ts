import { Struct } from "@bufbuild/protobuf";
import type { Context } from "../../packages/context/core.js";
import type { RemoteExecManager } from "../../packages/agent-exec/remote.js";
import type { ResourceAccessor } from "../../packages/agent-exec/resource-provider.js";
import { tryExtractSandAutoReviewClassifierConversationContext } from "../../packages/agent/smart-mode-classifier-context.js";
import { withToolExecutionTimeoutSuspended } from "../../packages/agent/tools/tool-timeout-suspension.js";
import { SmartModeRiskTarget, type SmartModeClassifierConversationMessage } from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";
import { fingerprintSandAutoReviewTarget, type SandAutoReviewController, type SandAutoReviewMode } from "./sand-auto-review.js";
import type { AutoReviewClassifierDecision } from "./sand-auto-review-classifier-run.js";
import { runSandAutoReviewClassifier } from "./sand-auto-review-classifier-run.js";
import { summarizeSandBrowserAutoReviewAction } from "./sand-auto-review-summaries.js";
import { buildProjectPermissionsContext, SAND_COMPUTER_CLASSIFIER_TARGET_ACTION, type BoxIdentity } from "./sand-computer-auto-review.js";
export const SAND_BROWSER_AUTO_REVIEW_MAX_ELEMENT_CHARS = 500, SAND_BROWSER_AUTO_REVIEW_MAX_TEXT_CHARS = 2_000, SAND_BROWSER_AUTO_REVIEW_MAX_URL_CHARS = 2_000, SAND_BROWSER_AUTO_REVIEW_MAX_KEY_CHARS = 256, SAND_BROWSER_AUTO_REVIEW_MAX_CDP_PARAMS_CHARS = 2_000;
const BYPASS = new Set(["snapshot", "screenshot", "get_bounding_box", "highlight", "scroll"]);
export class SandBrowserAutoReviewBlockedError extends Error { override readonly name = "SandBrowserAutoReviewBlockedError"; }
export interface BrowserAction { readonly op: string; readonly tabsAction?: string | undefined; readonly element?: string | undefined; readonly url?: string | undefined; readonly text?: string | undefined; readonly value?: string | undefined; readonly values?: readonly string[] | undefined; readonly key?: string | undefined; readonly cdpMethod?: string | undefined; readonly cdpParams?: string | undefined; readonly tabIndex?: number | undefined; readonly [key: string]: unknown }
export function isSandBrowserAutoReviewMutatingAction(action: BrowserAction): boolean { return action.op === "tabs" ? action.tabsAction === "new" || action.tabsAction === "close" : !BYPASS.has(action.op); }
function bounded(value: string | undefined, field: string, max: number): void { if ((value?.length ?? 0) > max) throw new SandBrowserAutoReviewBlockedError(`Browser Auto-review rejected oversized ${field} (max ${max} characters).`); }
export function normalizeSandBrowserExactActionArgs<T extends BrowserAction>(action: T): T { bounded(action.url, "url", 2_000); bounded(action.text, "text", 2_000); bounded(action.value, "value", 2_000); bounded(action.key, "key", 256); bounded(action.cdpParams, "params", 2_000); if ((action.values?.join(", ").length ?? 0) > 2_000) bounded("x".repeat(2_001), "values", 2_000); return action; }
export function normalizeSandBrowserElement(element?: string): string | undefined { const trimmed = element?.trim(); if (!trimmed) return undefined; bounded(trimmed, "element", 500); return trimmed; }
export function buildSandBrowserAutoReviewCanonicalTarget(args: { exactAction: BrowserAction; boxIdentity: BoxIdentity; reviewState: { displayStateIdentity: string; targetPageUrl?: string } }) { const action = normalizeSandBrowserExactActionArgs(args.exactAction), element = normalizeSandBrowserElement(action.element); return { exactAction: { ...action, ...(element == null ? {} : { element }) }, boxIdentity: args.boxIdentity, displayStateIdentity: args.reviewState.displayStateIdentity, ...(args.reviewState.targetPageUrl == null ? {} : { targetPageUrl: args.reviewState.targetPageUrl }) }; }
export function fingerprintSandBrowserAutoReviewTarget(target: ReturnType<typeof buildSandBrowserAutoReviewCanonicalTarget>): string { return fingerprintSandAutoReviewTarget({ exact_action: target.exactAction, window_generation: target.boxIdentity.windowGeneration, box_id: target.boxIdentity.boxId, display_state_identity: target.displayStateIdentity, target_page_url: target.targetPageUrl }); }
export function buildSandBrowserClassifierRiskTarget(args: { canonicalTarget: ReturnType<typeof buildSandBrowserAutoReviewCanonicalTarget>; personalInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] }; userAutoRunInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] }; projectAutoRunInstructions?: { allowInstructions?: readonly string[]; blockInstructions?: readonly string[] } }): unknown {
  const action: BrowserAction = args.canonicalTarget.exactAction;
  const argumentsJson = JSON.parse(JSON.stringify({
    surface: "browser",
    action_kind: `browser_${action.op}`,
    view_id: action.viewId,
    target_page_url: args.canonicalTarget.targetPageUrl,
    url: action.url,
    ref: action.ref,
    text: action.text,
    value: action.value,
    values: action.values,
    key: action.key,
    cdp_method: action.cdpMethod,
    cdp_params: action.cdpParams,
    tabs_action: action.tabsAction,
    tab_index: action.tabIndex,
    coordinates: action.x == null || action.y == null ? undefined : { x: action.x, y: action.y },
    drag_source_ref: action.sourceRef,
    drag_target_ref: action.targetRef,
    drag_target_coordinates: action.targetX == null || action.targetY == null ? undefined : { x: action.targetX, y: action.targetY },
    new_tab: action.newTab,
    submit: action.submit,
    clear: action.clear,
    double_click: action.doubleClick,
    button: action.button,
    modifiers: action.modifiers,
    declared_purpose: action.element,
    box: {
      box_id: args.canonicalTarget.boxIdentity.boxId,
      window_generation: args.canonicalTarget.boxIdentity.windowGeneration,
      display_state_identity: args.canonicalTarget.displayStateIdentity,
    },
    project_permissions: buildProjectPermissionsContext(args),
  }));
  return new SmartModeRiskTarget({
    action: SAND_COMPUTER_CLASSIFIER_TARGET_ACTION,
    arguments: Struct.fromJson(argumentsJson),
  });
}

export interface SandBrowserAutoReviewOptions {
  readonly mode: SandAutoReviewMode;
  readonly agentId: string;
  readonly boxIdentity: BoxIdentity;
  readonly autoReviewController?: SandAutoReviewController;
  readonly resolveDisplayNumber: (ctx: Context) => Promise<number | undefined>;
  readonly personalInstructions?: { readonly allowInstructions?: readonly string[]; readonly blockInstructions?: readonly string[] };
  readonly userAutoRunInstructions?: { readonly allowInstructions?: readonly string[]; readonly blockInstructions?: readonly string[] };
  readonly projectAutoRunInstructions?: { readonly allowInstructions?: readonly string[]; readonly blockInstructions?: readonly string[] };
  readonly extractConversationContext?: (ctx: Context, stateHandler: unknown) => Promise<readonly SmartModeClassifierConversationMessage[]>;
  readonly getApprovalExpiryPolicy?: () => "park" | "ttl";
}

export async function runSandBrowserAutoReviewPreflight(args: {
  readonly ctx: Context;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly exactAction: BrowserAction;
  readonly toolCallId: string;
  readonly stateHandler?: unknown;
  readonly workspacePaths?: readonly string[];
  readonly signal?: AbortSignal;
  readonly options: SandBrowserAutoReviewOptions & {
    readonly captureReviewState: (ctx: Context, toolCallId: string) => Promise<{ displayStateIdentity: string; targetPageUrl?: string }>;
  };
}): Promise<void> {
  const { options } = args, op = args.exactAction.op;
  if (options.mode === "off" || !isSandBrowserAutoReviewMutatingAction(args.exactAction)) return;
  if (options.mode === "enforce" && ["click", "mouse_click_xy", "drag"].includes(op) && normalizeSandBrowserElement(args.exactAction.element) == null) throw new SandBrowserAutoReviewBlockedError("Browser click and drag actions require an element field: a concise description of the intended target and purpose.");
  const classifierMode = options.mode === "shadow" ? "shadow" : "enforce";
  const canonical = buildSandBrowserAutoReviewCanonicalTarget({ exactAction: args.exactAction, boxIdentity: options.boxIdentity, reviewState: await options.captureReviewState(args.ctx, args.toolCallId) }), fingerprint = fingerprintSandBrowserAutoReviewTarget(canonical);
  const recheck = async (): Promise<void> => { if ((await options.captureReviewState(args.ctx, args.toolCallId)).displayStateIdentity !== canonical.displayStateIdentity) { options.autoReviewController?.reportDisplayRecheckFailed(options.agentId); throw new SandBrowserAutoReviewBlockedError("The page changed after review; take a fresh browser_snapshot and retry the action."); } };
  const runClassifier = () => runSandAutoReviewClassifier({
    ctx: args.ctx,
    resourceAccessor: args.resourceAccessor,
    toolCallId: args.toolCallId,
    mode: classifierMode,
    buildTarget: () => buildSandBrowserClassifierRiskTarget({ canonicalTarget: canonical, ...(options.personalInstructions === undefined ? {} : { personalInstructions: options.personalInstructions }), ...(options.userAutoRunInstructions === undefined ? {} : { userAutoRunInstructions: options.userAutoRunInstructions }), ...(options.projectAutoRunInstructions === undefined ? {} : { projectAutoRunInstructions: options.projectAutoRunInstructions }) }) as SmartModeRiskTarget,
    loadConversationContext: async () => {
      if (args.stateHandler === undefined) return [];
      if (options.extractConversationContext !== undefined) return [...await options.extractConversationContext(args.ctx, args.stateHandler)];
      return [...await tryExtractSandAutoReviewClassifierConversationContext(args.ctx, args.stateHandler as never)];
    },
    ...(args.workspacePaths === undefined ? {} : { workspacePaths: args.workspacePaths }),
    errorReason: "An error occurred while classifying this action. Please review manually.",
  });
  if (options.mode === "shadow") {
    void runClassifier().catch((error: unknown) => {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
    });
    return;
  }
  const decision = await runClassifier();
  if (decision.kind === "allow") { await recheck(); return; }
  if (decision.kind === "block" && options.autoReviewController != null) {
    const action = canonical.exactAction;
    const summary = summarizeSandBrowserAutoReviewAction({
      op: action.op,
      ...(action.element === undefined ? {} : { element: action.element }),
      ...(canonical.targetPageUrl === undefined ? {} : { targetPageUrl: canonical.targetPageUrl }),
      ...(action.url === undefined ? {} : { url: action.url }),
      ...(action.text === undefined ? {} : { text: action.text }),
      ...(action.value === undefined ? {} : { value: action.value }),
      ...(action.values === undefined ? {} : { values: action.values }),
      ...(action.key === undefined ? {} : { key: action.key }),
      ...(action.cdpMethod === undefined ? {} : { cdpMethod: action.cdpMethod }),
      ...(action.cdpParams === undefined ? {} : { cdpParams: action.cdpParams }),
      ...(action.tabsAction === undefined ? {} : { tabsAction: action.tabsAction }),
      ...(action.tabIndex === undefined ? {} : { tabIndex: action.tabIndex }),
    });
    const approval = await withToolExecutionTimeoutSuspended(args.ctx, () => options.autoReviewController!.requestApproval({ agentId: options.agentId, surface: "computer", fingerprint, reason: decision.reason, summary, ...(decision.proposedRule == null ? {} : { proposedRule: decision.proposedRule }), ...(args.signal == null ? {} : { signal: args.signal }), ...(options.getApprovalExpiryPolicy == null ? {} : { expiryPolicy: options.getApprovalExpiryPolicy() }) })); if (args.signal?.aborted === true) throw new SandBrowserAutoReviewBlockedError("The browser action was cancelled."); if (approval.approved) { await recheck(); return; } throw new SandBrowserAutoReviewBlockedError(approval.reason ?? decision.reason); }
  throw new SandBrowserAutoReviewBlockedError(decision.reason);
}
