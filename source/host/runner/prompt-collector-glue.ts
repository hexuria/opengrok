import path from "node:path";
import { SAND_BOX_READ_TOOL_NAME, SAND_BOX_SHELL_TOOL_NAME } from "../sand-activity.js";
import { buildMcpCustomInstructionsSystemPromptSection } from "../../shared/mcp-custom-instructions.js";
import {
  agentProfileIdentitiesEqual,
  normalizeAgentProfileIdentity,
  parseLatestAgentProfileUpdate,
  renderAgentProfileUpdate,
  type AgentProfileIdentity,
  type AgentProfilePromptSnapshot,
} from "./sand-agent-profile-prompt.js";
import { SAND_HIDDEN_PROMPT_MARKER, SAND_TRUSTED_AUTOMATION_PROMPT_MARKER } from "./sand-prompt-markers.js";
import { appendUserReplyReminder, buildAttachedFilesNote, buildReplyContextNote, buildUserMessageAddressNote } from "./system-prompt.js";
import { bytesLookLikeVideoContainer } from "./video-container.js";
import { collectPrependUserMessages, type ShellTerminalWatchHost } from "./shell-terminal-watch.js";
import { SAND_BOX_WORKSPACE_ROOT } from "../cloud-agents/cloud-agent-images.js";
import { downloadBoxFiles, type TransferBox } from "../box/box-transfer.js";
import {
  renderAutomationClearedStatusReminder,
  renderAutomationRuntimeStatusReminder,
  type AutomationRecord,
} from "../automations/automation.js";
import type { AutomationStatusReminderRequestContext, AutomationStatusReminderStore } from "../automations/automation-status-reminder.js";
import {
  ConversationAction,
  UserMessage,
  UserMessageAction,
} from "../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  SelectedContext,
  SelectedImage,
  SelectedVideo as GeneratedSelectedVideo,
} from "../../packages/proto/generated/agent/v1/selected_context_pb.js";

export class SandVideoAttachmentError extends Error {}

export interface PromptMessage { readonly role: string; readonly content: string | readonly { readonly text?: string }[] }
export interface SelectedVideo { readonly path: string; readonly filename?: string; readonly data?: Uint8Array; readonly blobId?: string }
export interface TurnPromptOptions {
  readonly selectedImages?: readonly { readonly data: Uint8Array; readonly path?: string; readonly mimeType?: string }[];
  readonly selectedVideos?: readonly SelectedVideo[];
  readonly attachedFilePaths?: readonly string[];
  readonly attachedFileSizes?: ReadonlyMap<string, number>;
  readonly richText?: string;
  readonly replyContext?: unknown;
  readonly messageId?: string;
  readonly automationWake?: { readonly id?: string; readonly containsUntrustedEventText?: boolean };
  readonly isSilenceAllowed?: boolean;
  readonly appendReplyReminder?: boolean;
  readonly hidden?: boolean;
  readonly recentUserMessages?: readonly unknown[];
  readonly skippedQuestionPrompts?: readonly string[];
  readonly dismissedQuestionPrompts?: readonly string[];
}
export interface PromptCollectorHost<Context = unknown> {
  readonly ctx?: Context;
  readonly box?: TransferBox | undefined;
  readonly isSubagentRunner?: boolean | undefined;
  readonly isComputerUseSubagent?: boolean | undefined;
  readonly isBrowserUseSubagent?: boolean | undefined;
  readonly remoteBoxHasDesktop?: boolean | undefined;
  readonly remoteBox?: TransferBox | undefined;
  resolveBoxId?(): string;
  readonly requestContext?: AutomationStatusReminderRequestContext | undefined;
  readonly automationStore?: AutomationStatusReminderStore | null | undefined;
  readonly shellWatchHost?: (() => ShellTerminalWatchHost<Context>) | undefined;
  readonly agentProfileProvider?: (() => AgentProfileIdentity) | undefined;
  readonly mcp?: { getCustomInstructions(ctx: Context): Promise<ReadonlyMap<string, string>> } | undefined;
  mcpConnectedServerNamesForTurn?(): readonly string[];
  mcpCustomInstructionsForTurn?(): ReadonlyMap<string, string>;
  isMcpDiscoveryUnavailableForTurn?(): boolean;
  isBrowserUseSubagentEnabled?: (() => boolean) | undefined;
  resolveBoxBrowser?: (() => { readonly display: string; readonly cdpUrl: string } | null) | undefined;
  getConversationId?: (() => string) | undefined;
  getAutomationStatusReminder?: ((firingAutomationId?: string) => string | null) | undefined;
  uploadAttachmentsIntoBox?: ((paths: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined;
  getRemoteBoxAvailable?: (() => boolean) | undefined;
  readVideoAttachmentBytes?: ((path: string) => Promise<Uint8Array | null>) | undefined;
  readBoxFile?: ((path: string) => Promise<Uint8Array | null>) | undefined;
  collectPrependUserMessages?: ((recent: readonly unknown[], messageId?: string) => Promise<readonly unknown[]>) | undefined;
  collectGeneratedPrependUserMessages?(
    recent: readonly { readonly id: string; readonly text: string; readonly richText?: string }[],
    messageId?: string,
  ): Promise<readonly UserMessage[]>;
  traceSendPhase?<T>(context: unknown, name: string, operation: () => Promise<T>): Promise<T>;
  isSpotlightEnabled?: (() => boolean) | undefined;
}

export interface TurnActionAssembly {
  readonly action: {
    readonly action: {
      readonly case: "userMessageAction";
      readonly value: {
        readonly userMessage: {
          readonly text: string; readonly messageId: string; readonly richText?: string;
          readonly selectedContext?: { readonly selectedImages: readonly unknown[]; readonly selectedVideos: readonly SelectedVideo[] };
        };
        readonly prependUserMessages: readonly unknown[];
      };
    };
  };
  readonly automationStatusReminder: string | null;
  readonly automationStatusCompactionEpoch: number;
}

export interface GeneratedTurnPromptOptions {
  readonly selectedImages?: readonly { readonly data: Uint8Array; readonly path?: string; readonly mimeType?: string }[];
  readonly selectedVideos?: readonly GeneratedSelectedVideo[];
  readonly attachedFilePaths?: readonly string[];
  readonly attachedFileSizes?: ReadonlyMap<string, number>;
  readonly richText?: string;
  readonly replyContext?: unknown;
  readonly messageId?: string;
  readonly automationWake?: { readonly id?: string; readonly containsUntrustedEventText?: boolean };
  readonly isSilenceAllowed?: boolean;
  readonly appendReplyReminder?: boolean;
  readonly hidden?: boolean;
  readonly recentUserMessages?: readonly { readonly id: string; readonly text: string; readonly richText?: string }[];
  readonly skippedQuestionPrompts?: readonly string[];
  readonly dismissedQuestionPrompts?: readonly string[];
}

export interface GeneratedTurnActionAssembly {
  readonly action: ConversationAction;
  readonly automationStatusReminder: string | null;
  readonly automationStatusCompactionEpoch: number;
}

function messageText(content: PromptMessage["content"]): string {
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n");
}

export function createPromptCollectorGlue<Context = unknown>(host: PromptCollectorHost<Context>) {
  let lastAutomationStatusReminder: string | undefined;
  let lastAutomationStatusCompactionEpoch: number | undefined;

  function getLatestAgentProfileUpdate(messages: readonly PromptMessage[]): AgentProfileIdentity | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "user") continue;
      const update = parseLatestAgentProfileUpdate(messageText(message.content));
      if (update != null) return update;
    }
    return null;
  }

  function getAutomationStatusReminderForTurn(compactionEpoch: number, firingAutomationId?: string): string | null {
    const directStore = host.automationStore;
    const rendered = directStore != null && host.requestContext != null && directStore.getLocation() != null
      ? renderAutomationRuntimeStatusReminder(
        (directStore.listDefinitions?.() ?? directStore.list()).slice(0, 100),
        host.requestContext.resolve().timeZone,
        firingAutomationId == null ? undefined : { firingAutomationId },
      )
      : host.getAutomationStatusReminder?.(firingAutomationId) ?? null;
    const compactionAdvanced = lastAutomationStatusCompactionEpoch != null && compactionEpoch > lastAutomationStatusCompactionEpoch;
    if (rendered != null) return rendered === lastAutomationStatusReminder && !compactionAdvanced ? null : rendered;
    if (lastAutomationStatusReminder == null) return null;
    const clearing = renderAutomationClearedStatusReminder();
    return clearing === lastAutomationStatusReminder && !compactionAdvanced ? null : clearing;
  }

  function getMcpCustomInstructionsSection(): string | null {
    if (host.isSubagentRunner === true || host.mcp == null) return null;
    return buildMcpCustomInstructionsSystemPromptSection(host.mcpConnectedServerNamesForTurn?.() ?? [], host.mcpCustomInstructionsForTurn?.() ?? new Map());
  }

  function getMcpDiscoveryStatusSection(): string | null {
    if (host.isSubagentRunner === true || host.mcp == null || host.isMcpDiscoveryUnavailableForTurn?.() !== true) return null;
    return "<mcp_status>\nYour MCP tools are temporarily unavailable: discovering the user's MCP connectors from the backend failed this turn. This does NOT mean the user has no MCP connectors. Do not claim they have none or that a connector is missing; if the user needs an MCP tool, tell them MCP is temporarily unavailable and to retry shortly.\n</mcp_status>";
  }

  async function resolveMcpCustomInstructions(): Promise<ReadonlyMap<string, string>> {
    if (host.isSubagentRunner === true || host.mcp == null || host.ctx == null) return new Map();
    try { return await host.mcp.getCustomInstructions(host.ctx); } catch { return new Map(); }
  }

  function appendProfileUpdateToHistory(messages: readonly PromptMessage[], snapshot: AgentProfilePromptSnapshot, onAppended: (identity: AgentProfileIdentity) => void): readonly PromptMessage[] | undefined {
    if (host.agentProfileProvider == null) return undefined;
    const identity = normalizeAgentProfileIdentity(host.agentProfileProvider());
    const latest = getLatestAgentProfileUpdate(messages) ?? snapshot.systemIdentity;
    if (agentProfileIdentitiesEqual(identity, latest) || !messages.some((message) => message.role === "system")) return undefined;
    onAppended(identity);
    return [...messages, { role: "user", content: renderAgentProfileUpdate(identity) }];
  }

  function getRemoteBoxSection(): string {
    if (host.isComputerUseSubagent === true) return getComputerUseRemoteBoxSection();
    if (host.isBrowserUseSubagent === true) return getBrowserUseRemoteBoxSection();
    return [
      "## Your box",
      "Alongside the user's computer you have the box, with structured file reads (Read), a shell (Shell), and your own desktop with a browser. The box is ONE persistent Linux machine shared by all of this user's agents — same filesystem and machine state, so a file, installed tool, or browser login set up by any agent is there for every agent — while the desktop is per-agent: each agent gets its own screen and browser window on that shared machine, and none sees or drives another's. Keep the two apart when explaining how this works: agents share the computer; they do not share desktops (never claim each agent has its own machine). It is a full computer: install tools, run code, and generate files (spreadsheets, CSVs, documents, images, archives) with Shell. Nothing on it touches the user's filesystem, sessions, or accounts, and anything set up there persists across turns, including files, installed tools, and especially browser logins. The user can open your desktop to watch or help.",
      "- Use ExternalRead and ExternalShell for the user's own computer (their files and local environment).",
      "- Use Read for line-numbered, paged text on the box, and for box images you need to see inline. Use Shell for commands, scratch work, risky operations, generating files, or anything that shouldn't run on the user's machine. Shell starts in /workspace, your scratch space on the box.",
      "- Use poppler-utils to read PDFs.",
      "- Read, Shell, and the box's browser share one filesystem, so a file you create with Shell can be opened, uploaded, or imported in the browser, and browser downloads can be inspected with Read or processed with Shell. Move data between code and web apps through files on the box.",
      "- Your box and the user's computer are separate machines with separate filesystems, so a path on one is not visible to the other: don't hand an ExternalRead/ExternalShell path from the user's computer to Read/Shell, or a box path to ExternalRead/ExternalShell. Move files across with CopyToBox / CopyFromBox.",
      "- CopyToBox (their computer -> your box): copies a file from the user's computer into your box, verbatim (any type or size, binaries included). Give the file's absolute ExternalRead/ExternalShell path; it lands in /workspace/uploads by default, or at a box_path you pick, then open it with Read or process it with Shell. Use this whenever you need to work on a user's file with your box's tools — you don't need them to drag it into chat first. (Files they do attach in chat are still copied into /workspace/uploads for you automatically, and the attached-files note lists both paths.)",
      "- CopyFromBox (your box -> their computer): copies a file from your box onto the user's actual computer, verbatim, where ExternalRead, ExternalShell, their editor, and apps can reach it. Give the box_path; it lands under its own name in the ExternalShell working directory, or at a computer_path you pick. Expand any glob in Shell first and pass concrete paths. This is for putting a file ON their disk; to instead show a file inline in chat (an image or video, or hand over a downloadable file) attach it by its box path with SendMessage.",
      "- Both transfers default to your single connected computer; pass `computer` only if you're told about more than one.",
    ].join("\n");
  }
  function getComputerUseRemoteBoxSection(): string {
    return [
      "## Your box",
      "You drive this agent's own desktop on the box: a persistent Linux machine shared by all of this user's agents, where each agent gets its own desktop — you control this agent's with Computer — plus file reads (Read) and a shell (Shell). All three share one filesystem, so a file you build with Shell can be uploaded or imported in the browser, and browser downloads can be inspected with Read or processed with Shell. Shell starts in /workspace, your scratch space; files, installed tools, and browser logins persist across turns. The box is the only filesystem you can reach — the user's computer is a separate machine you have no tools for — so when a file needs to reach the user, leave it on the box and name its absolute box path in your final report; the parent agent delivers it from there.",
    ].join("\n");
  }
  function getBrowserUseRemoteBoxSection(): string {
    return [
      "## Your box",
      `You drive this agent's box browser: the box is a persistent Linux machine shared by all of this user's agents (each gets its own desktop and browser window on it; this browser is this agent's own), with file reads (${SAND_BOX_READ_TOOL_NAME}), a shell (${SAND_BOX_SHELL_TOOL_NAME}), and a browser you control at the page level with the browser_* tools. All three share one filesystem, so a file you build with ${SAND_BOX_SHELL_TOOL_NAME} can be uploaded in the browser, and browser downloads can be inspected with ${SAND_BOX_READ_TOOL_NAME} or processed with ${SAND_BOX_SHELL_TOOL_NAME}. ${SAND_BOX_SHELL_TOOL_NAME} starts in /workspace, your scratch space; files, installed tools, and browser logins persist across turns. The box is the only filesystem you can reach — the user's computer is a separate machine you have no tools for — so when a file needs to reach the user, leave it on the box and name its absolute box path in your final report; the parent agent delivers it from there.`,
    ].join("\n");
  }

  function getComputerSection(): string | null {
    if (host.remoteBoxHasDesktop !== true) return null;
    if (host.isComputerUseSubagent === true) {
      const boxBrowser = host.resolveBoxBrowser?.() ?? null;
      return [
        "## Computer",
        "You drive this box's desktop with the Computer tool (screenshot, click, move, drag, type, key, scroll, wait): browsing, signing in to sites, and GUI apps.",
        "- Stay inside the task you were handed — it's deliberately narrow. Do exactly that step and its success criteria, then stop. If it turns out bigger or more ambiguous than scoped, stop and report what you found and what's needed rather than improvising.",
        "- Move bulk or structured data through files, not the keyboard: build it once with Shell (e.g. a CSV) and use the web app's own import or upload instead of typing values in cell by cell; to pull data out, download it in the browser and process it with Shell or Read. Enter data field by field only when there is no import path.",
        "- Work in a tight see-act-verify loop: screenshot to see the real state, act, then read the one fresh screenshot returned after the entire Computer call before deciding the next one. A batched `then` sequence returns only its final screen, so batch only steps that need no intermediate verification. Never fire actions blind off a remembered layout — coordinates drift as pages load and reflow.",
        "- Let the UI settle: if the screen is mid-load or still animating, `wait` a beat and re-screenshot rather than clicking into a moving target.",
        "- Recover from mis-clicks instead of barrelling on. If an action errors or the screenshot isn't what you expected — the page moved, a dialog opened — study the new screenshot and re-target at the current coordinates. Never type or clear text right after a click that didn't land; the field may not be focused, so click it again first.",
        "- Before typing into a field that may already hold text, clear it first (key Control+a, then key BackSpace). If your typed text doesn't show up, the field isn't focused — click it and try again.",
        "- A keyboard shortcut can silently not register: after one meant to open a palette or search (Ctrl+K, Ctrl+F), confirm from the screenshot that it opened and holds focus before typing — if it didn't, focus is likely still where it was (often a message composer), so click the affordance and retry. Never press Enter on a typed query until you've confirmed focus is in the intended field, or a missed shortcut turns your query into a sent message.",
        "- Chrome prewarms without a window when this task starts. For browser work, open it from Shell with the box's own launcher. Pass the target URL when known so Chrome opens straight there — `box-chrome 'https://example.com'`; otherwise run `box-chrome --new-window`. The launcher uses your DISPLAY, profile, and CDP port and returns once the window is visible. Confirm it with one Computer screenshot. Never launch another browser or download browser binaries. If Chrome still has not opened after two verified attempts, stop and report that startup failed.",
        "- Always take the fastest path to a destination. When you know or can construct the exact URL — a deep link you were handed, or a site's own search/filter URL (e.g. `https://www.amazon.com/s?k=bread+flour` to search Amazon) — navigate straight to it instead of landing on the homepage and clicking through menus and search boxes. Encode as much of the request as the URL can carry: sites expose their search, filters, sort, and pagination as query params or path segments, so a well-built URL lands you on the already-narrowed result rather than a page you still have to refine by hand. Only fall back to navigating through the site's UI when you can't construct a URL for it — you don't know the site's URL scheme and one probe didn't reveal it, or the state genuinely isn't URL-addressable. A URL in your task is the destination itself: go directly to it, never re-create it by hand through the site's UI. Mid-session, put the URL in the address bar (key Ctrl+l, type the URL, key Return) rather than re-tracing the click path.",
        boxBrowser === null ? "- Your display is the `DISPLAY` your Shell already runs with — exactly the display Computer screenshots and clicks. Check it once (make your first Shell command `echo $DISPLAY`), then derive your loopback CDP port as 9222 plus that display number (`:1` uses `http://127.0.0.1:9223`, `:2` uses 9224). Never guess `:1` or probe other display numbers: a foreign display's browser answers CDP perfectly while being invisible to your user. Keep CDP box-local; never publish, proxy, or expose that port." : `- Your desktop is display \`${boxBrowser.display}\` — the display Computer screenshots and clicks — and your browser's CDP endpoint is \`${boxBrowser.cdpUrl}\`. Those are given facts, so never derive a port, probe for one, or spend a command reading \`$DISPLAY\`. A different port answering CDP is another display's browser your user cannot see. Keep CDP box-local; never publish, proxy, or expose that port.`,
        "- Other Chrome processes are not yours. The box runs a display per monitor and keeps profiles from earlier sessions, so `pgrep -a chrome` routinely lists browsers on other displays; never attach to a Chrome whose port is not your display's. The one check worth making is whether your own port answers `/json/version`; if it does not, your browser isn't running yet — open it with `box-chrome` rather than adopting someone else's.",
        "- A Chrome you can reach over CDP is not necessarily on screen: the prewarmed browser intentionally starts without a window. If Computer screenshots black or empty while your CDP port works, open its window through `box-chrome` and confirm with Computer. If the launcher returns but the window is still absent, stop and report the startup failure.",
        "- Hook up CDP with the packaged `playwright-core` (`chromium.connectOverCDP`), then reuse `browser.contexts()[0]` and its existing pages. Use CDP for bring-up and recovery — confirm the tab, `page.goto` when you already know the URL, inspect a stuck page — not as a replacement for Computer when driving the UI the user sees. When finished, call `browser.close()` to disconnect; do not close the reused context, pages, or Chrome itself.",
        "- Only Computer can tell you what the user sees. Playwright's `page.screenshot()` is a cheap way to look at a page yourself (write it to a file, open it with Read), but it renders straight from the tab and looks identical whether or not the window is on any display. Before you claim a page is on screen or ready to be taken over, confirm it with one Computer screenshot — if the desktop doesn't show it, that is the bug to report.",
        "- Keep Chrome's tabs tidy as ordinary housekeeping: reuse a relevant open tab rather than opening a duplicate, and once a step or phase is done, or tabs are visibly piling up, quietly close the ones you're finished with, without asking first or narrating each close. Never close a tab when that could lose work or strand the user, though: leave the active task's tabs, anything with unsaved form or editor state, an in-progress upload or download, a login/2FA/captcha/payment flow, a tab the user opened whose purpose you're unsure of, and any session you'll likely need for a near-term follow-up.",
        "- Never `pkill -f` from Shell. `-f` matches whole command lines, including the one it is running inside, so any pattern describing your own script, browser, or flag kills your shell mid-command (the signature: instant return, exit code 0, empty output). Kill the pid the tool reported, or `setsid` the replacement; if you must match by pattern, pick one that cannot appear in your own command.",
        "- Do not inspect cookies, storage, auth headers, password fields, hidden inputs, tokens, or unrelated account data. Redact sensitive or identifying values from the final report.",
        "- Don't loop, and know when to stop. If the same approach hasn't moved you forward after a couple of tries, change tack — scroll to find the element, reload the page, take a different route. The moment the goal is met, or you hit something you can't get past, end the turn and report rather than poking at a finished or blocked screen.",
        "- You can't talk to the user or hand off the box. If a step needs a human — a password, 2FA, a captcha, a payment — stop and say so clearly in your final report (name the site/step) so the parent can hand them the box; never try to enter their credentials.",
        "- Nobody reads the text you write between tool calls, so keep it to a few words or skip it. Two exceptions: when a result isn't what you expected, say what you actually see before re-targeting; and your final report.",
        "- End with a concise, self-contained report: what you did, what you saw, whether you met the goal, and if not, exactly what blocked you. That text is all the parent gets back.",
      ].join("\n");
    }
    if (host.isBrowserUseSubagent === true) return [
      "## Browser",
      "You drive this box's browser at the page level with the browser_* tools: navigate, snapshot, click, type, fill, select, press keys, scroll, and manage tabs. You act on element refs from browser_snapshot, never on pixel coordinates.",
      "- Stay inside the task you were handed — it's deliberately narrow. Do exactly that step and its success criteria, then stop. If it turns out bigger or more ambiguous than scoped, stop and report what you found and what's needed rather than improvising.",
      "- Always take the fastest path to a destination. When you know or can construct the exact URL — a deep link you were handed, or a site's own search/filter URL (e.g. `https://www.amazon.com/s?k=bread+flour` to search Amazon) — browser_navigate straight to it instead of landing on the homepage and clicking through menus and search boxes. Encode as much of the request as the URL can carry: sites expose their search, filters, sort, and pagination as query params or path segments, so a well-built URL lands you on the already-narrowed result rather than a page you still have to refine by hand. Only fall back to navigating through the site's UI when you can't construct a URL for it — you don't know the site's URL scheme and one probe didn't reveal it, or the state genuinely isn't URL-addressable. A URL in your task is the destination itself: go directly to it, never re-create it by hand through the site's UI.",
      "- Work in a snapshot-act-verify loop: browser_snapshot to see the page's real structure, act on a ref from it, then read the screenshot and page state returned by the action before deciding the next one. Refs are tied to the latest snapshot for that tab, so after a navigation or a page change take a fresh snapshot rather than reusing old refs.",
      "- Every browser action already returns a screenshot of the resulting page, so browser_take_screenshot is almost always redundant.",
      "- Your tools act on your own dedicated tab by default. Use browser_tabs and viewId only when the task genuinely needs several pages at once.",
      "- The browser is the box's own Chrome: its logins persist across turns, so a signed-in session from an earlier task is normally still live.",
      `- Move bulk or structured data through files, not the keyboard: build it once with ${SAND_BOX_SHELL_TOOL_NAME} (e.g. a CSV) and use the web app's own import or upload instead of filling values in field by field; to pull data out, download it in the browser and process it with ${SAND_BOX_SHELL_TOOL_NAME} or ${SAND_BOX_READ_TOOL_NAME}.`,
      "- Do not inspect cookies, storage, auth headers, password fields, hidden inputs, tokens, or unrelated account data. Redact sensitive or identifying values from the final report.",
      "- Don't loop, and know when to stop. If the same approach hasn't moved you forward after a couple of tries, change tack — scroll to find the element, reload the page, take a different route. The moment the goal is met, or you hit something you can't get past, end the turn and report rather than poking at a finished or blocked page.",
      "- You can't talk to the user or hand off the box. If a step needs a human — a password, 2FA, a captcha, a payment — stop and say so clearly in your final report (name the site/step) so the parent can hand them the box; never try to enter their credentials.",
      "- Nobody reads the text you write between tool calls, so keep it to a few words or skip it. Two exceptions: when a result isn't what you expected, say what you actually see before re-targeting; and your final report.",
      "- End with a concise, self-contained report: what you did, what you saw, whether you met the goal, and if not, exactly what blocked you. That text is all the parent gets back.",
    ].join("\n");
    if (host.isSubagentRunner === true) return null;
    const browserUseOffered = host.isBrowserUseSubagentEnabled?.() === true;
    return [
      "## The box desktop",
      ...(browserUseOffered ? [
        "You have your own desktop on the box (your screen alone — see Your box), with a browser, and you hold the read-only Screenshot tool to see its current screen, confirm where a flow landed, or check on a running subagent. You cannot click, move, type, press keys, scroll, or wait on the desktop yourself. Delegate every browser and desktop interaction to a subagent; like any Task it runs in the background, so you keep working and are revived with its result. Do not bypass this boundary with Shell-driven GUI automation such as xdotool, or by driving the box browser from Shell — no CDP attach, no Playwright, Puppeteer, or `websocket-client`, no `/json/new`, no cookie-DB scraping, and no page JS eval over DevTools. Browser work goes to `browserUse` first; the desktop itself goes to `computerUse`.",
        "- Reach for the `browserUse` subagent first for anything that happens in the browser: reading pages, filling forms, pulling data from sites, clicking through web apps. It drives the box's signed-in Chrome at the page level with element references instead of pixel clicks, so it is faster and more reliable than desktop automation, and it never touches the desktop's mouse, so it can run alongside other work. Logins and files persist in the box across turns, so a sign-in is a one-time step.",
        "- Use the `computerUse` subagent only when the task needs the desktop itself — GUI apps, file dialogs, drag interactions — or when a site defeats page-level automation. If a `browserUse` dispatch reports it could not operate a site, re-dispatch that same task to `computerUse` rather than retrying `browserUse` harder.",
      ] : [
        "You have your own desktop on the box (your screen alone — see Your box), with a browser, and you hold the read-only Screenshot tool to see its current screen, confirm where a flow landed, or check on a running computerUse subagent. You cannot click, move, type, press keys, scroll, or wait on the desktop yourself. Delegate every desktop interaction to a computerUse subagent; like any Task it runs in the background, so you keep working and are revived with its result. Do not bypass this boundary with Shell-driven GUI automation such as xdotool, or by driving the box browser from Shell — no CDP attach, no Playwright, Puppeteer, or `websocket-client`, no `/json/new`, no cookie-DB scraping, and no page JS eval over DevTools. Browser and GUI work goes through `computerUse` (and `browserUse` only when Task actually offers that type).",
        "- Reach for the computerUse subagent for browsing, signing in to sites, and GUI apps; logins and files persist in the box across turns, so a sign-in is a one-time step.",
      ]),
      "- Scope it tight — a narrow, well-defined task is your main defense against a subagent that stalls or wanders. Break a big GUI goal into the smallest concrete step(s) and dispatch those one at a time; several tightly-scoped dispatches beat one broad, open-ended objective. It runs headless and can't ask you follow-ups, so each task must stand on its own: the exact step, the specifics it needs (which site or account, exact values to enter, which button to land on), what \"done\" looks like and where to stop, and what to report back. A vague or sprawling task is how it gets lost. When you know the destination URL — one the user pasted, or one you can construct (a site's search/filter URL like `https://www.amazon.com/s?k=bread+flour`) — put that exact URL in the task, as specific as the site's query params allow, so the subagent opens it directly instead of clicking through the site to rebuild it.",
      browserUseOffered ? "- For bulk or structured data, don't type it in by hand: generate the file with Shell (e.g. a CSV), inspect it with Read when useful, then have the subagent import or upload it, far faster and more reliable than entering values one by one." : "- For bulk or structured data, don't type it in by hand: generate the file with Shell (e.g. a CSV), inspect it with Read when useful, then have the computerUse subagent import or upload it, far faster and more reliable than entering values one by one.",
      "- If it's running long or might be looping, look in with CheckSubagent rather than waiting it out; MessageSubagent redirects a stuck one mid-run (point it at the right element, or tell it the user just signed in) and StopSubagent aborts one that's wedged. When it returns, read its report before acting — if it stopped short or hit a step only the user can do, that's your cue to follow up or hand off the box.",
      "- You share your desktop's single screen with the computerUse subagent, so only one runs at a time; while one is running, leave the screen to it and limit yourself to a screenshot to check in rather than clicking or typing. (The user's other agents have their own desktops, so their work never appears on yours.)",
      "- When a step needs the user (a login, 2FA, captcha, or payment), hand them the box with request_box_help directly — don't first ask with a question widget (or in prose) whether to hand it over, since the tool is itself both the handoff and the ask: it surfaces the box with a hand-back button and shows your instruction, so a \"hand you the box now?\" widget is just redundant friction. Pass one short instruction (no paragraph) like \"Sign in to your Google account\" (you never see their password); once they hand it back, dispatch the subagent again to continue.",
    ].join("\n");
  }

  async function readBoxVideoBytes(videoPath: string): Promise<Uint8Array | null> {
    const normalized = path.posix.normalize(videoPath);
    if (host.remoteBox == null || host.resolveBoxId == null || host.remoteBoxHasDesktop !== true || !normalized.startsWith(`${SAND_BOX_WORKSPACE_ROOT}/`)) return null;
    try {
      const bytes = (await downloadBoxFiles(host.ctx, host.remoteBox, host.resolveBoxId(), [normalized])).get(normalized) ?? null;
      return bytes != null && bytes.byteLength <= 100 * 1024 * 1024 && bytesLookLikeVideoContainer(bytes) ? bytes : null;
    } catch { return null; }
  }

  async function resolveSelectedVideosForTurn(videos: readonly SelectedVideo[]): Promise<SelectedVideo[]> {
    if (videos.length === 0 || host.isSubagentRunner !== true) return [...videos];
    const resolved: SelectedVideo[] = [];
    for (const video of videos) {
      if (video.data != null || video.blobId != null) { resolved.push(video); continue; }
      const videoPath = video.path.trim();
      const bytes = await host.readVideoAttachmentBytes?.(videoPath) ?? await readBoxVideoBytes(videoPath);
      if (bytes == null) throw new SandVideoAttachmentError(`Cannot read video attachment for review: ${video.filename ?? (videoPath || "unknown")}.`);
      resolved.push({ ...video, data: bytes });
    }
    return resolved;
  }

  async function resolveGeneratedSelectedVideosForTurn(
    videos: readonly GeneratedSelectedVideo[],
  ): Promise<GeneratedSelectedVideo[]> {
    if (videos.length === 0 || host.isSubagentRunner !== true) return [...videos];
    const resolved: GeneratedSelectedVideo[] = [];
    for (const video of videos) {
      if (video.dataOrBlobId.case !== undefined) {
        resolved.push(video);
        continue;
      }
      const videoPath = video.path.trim();
      const bytes = await host.readVideoAttachmentBytes?.(videoPath) ?? await readBoxVideoBytes(videoPath);
      if (bytes == null) {
        throw new SandVideoAttachmentError(
          `Cannot read video attachment for review: ${video.filename || (videoPath || "unknown")}.`,
        );
      }
      resolved.push(new GeneratedSelectedVideo({
        uuid: video.uuid,
        path: video.path,
        ...(video.fps === undefined ? {} : { fps: video.fps }),
        mimeType: video.mimeType,
        filename: video.filename,
        materializeToFilesystem: video.materializeToFilesystem,
        dataOrBlobId: { case: "data", value: bytes },
      }));
    }
    return resolved;
  }

  async function assembleTurnAction(args: {
    readonly trimmedPrompt: string; readonly options: TurnPromptOptions;
    readonly profileUpdateForTurn?: { readonly text: string }; readonly compactionEpoch: () => number;
  }): Promise<TurnActionAssembly> {
    const { options } = args;
    const files = options.attachedFilePaths ?? [];
    let staged = new Map<string, string>();
    if (files.length > 0 && host.uploadAttachmentsIntoBox != null && host.getRemoteBoxAvailable?.() === true) {
      try { staged = new Map(await host.uploadAttachmentsIntoBox(files)); } catch {}
    }
    const address = buildUserMessageAddressNote(options.messageId);
    const reply = buildReplyContextNote(options.replyContext);
    let text = [address, reply].filter(Boolean).join("\n");
    text = text.length > 0 && args.trimmedPrompt.length > 0 ? `${text}\n${args.trimmedPrompt}` : text || args.trimmedPrompt;
    const attachments = buildAttachedFilesNote(files, staged, options.attachedFileSizes);
    if (attachments.length > 0) text = text.length > 0 ? `${text}\n\n${attachments}` : attachments;
    const epoch = args.compactionEpoch();
    const reminder = getAutomationStatusReminderForTurn(epoch, options.automationWake?.id);
    const above = options.isSilenceAllowed === true;
    if (reminder != null) text = text.length === 0 ? reminder : above ? `${reminder}\n\n${text}` : `${text}\n\n${reminder}`;
    if (args.profileUpdateForTurn != null) text = text.length === 0 ? args.profileUpdateForTurn.text : above ? `${args.profileUpdateForTurn.text}\n\n${text}` : `${text}\n\n${args.profileUpdateForTurn.text}`;
    if (options.appendReplyReminder === true && options.hidden !== true) text = appendUserReplyReminder(text);
    if (options.hidden === true) text = `${SAND_HIDDEN_PROMPT_MARKER}${options.automationWake == null || options.automationWake.containsUntrustedEventText === true ? "" : SAND_TRUSTED_AUTOMATION_PROMPT_MARKER}${text}`;
    const videos = await resolveSelectedVideosForTurn(options.selectedVideos ?? []);
    const images = options.selectedImages ?? [];
    const richText = options.richText?.trim();
    const prepended = [...await host.collectPrependUserMessages?.(options.recentUserMessages ?? [], options.messageId) ?? []];
    const unanswered = [...(options.skippedQuestionPrompts ?? []), ...(options.dismissedQuestionPrompts ?? [])];
    if (unanswered.length > 0) prepended.push({ text: `Unanswered questions:\n${unanswered.map((question) => `- ${question}`).join("\n")}` });
    const userMessage = {
      text, messageId: options.messageId ?? "",
      ...(richText == null || richText.length === 0 ? {} : { richText }),
      ...(images.length === 0 && videos.length === 0 ? {} : { selectedContext: { selectedImages: images, selectedVideos: videos } }),
    };
    return { action: { action: { case: "userMessageAction", value: { userMessage, prependUserMessages: prepended } } }, automationStatusReminder: reminder, automationStatusCompactionEpoch: epoch };
  }

  async function assembleGeneratedTurnAction(args: {
    readonly runCtx: unknown;
    readonly trimmedPrompt: string;
    readonly options: GeneratedTurnPromptOptions;
    readonly profileUpdateForTurn?: { readonly text: string };
    readonly compactionEpoch: () => number;
  }): Promise<GeneratedTurnActionAssembly> {
    const { options } = args;
    const files = options.attachedFilePaths ?? [];
    let staged = new Map<string, string>();
    if (files.length > 0 && host.uploadAttachmentsIntoBox != null && host.getRemoteBoxAvailable?.() === true) {
      try { staged = new Map(await host.uploadAttachmentsIntoBox(files)); } catch {}
    }
    const address = buildUserMessageAddressNote(options.messageId);
    const reply = buildReplyContextNote(options.replyContext);
    let text = [address, reply].filter(Boolean).join("\n");
    text = text.length > 0 && args.trimmedPrompt.length > 0 ? `${text}\n${args.trimmedPrompt}` : text || args.trimmedPrompt;
    const attachments = buildAttachedFilesNote(files, staged, options.attachedFileSizes);
    if (attachments.length > 0) text = text.length > 0 ? `${text}\n\n${attachments}` : attachments;
    const epoch = args.compactionEpoch();
    const reminder = getAutomationStatusReminderForTurn(epoch, options.automationWake?.id);
    const above = options.isSilenceAllowed === true;
    if (reminder != null) text = text.length === 0 ? reminder : above ? `${reminder}\n\n${text}` : `${text}\n\n${reminder}`;
    if (args.profileUpdateForTurn != null) text = text.length === 0 ? args.profileUpdateForTurn.text : above ? `${args.profileUpdateForTurn.text}\n\n${text}` : `${text}\n\n${args.profileUpdateForTurn.text}`;
    if (options.appendReplyReminder === true && options.hidden !== true) text = appendUserReplyReminder(text);
    if (options.hidden === true) text = `${SAND_HIDDEN_PROMPT_MARKER}${options.automationWake == null || options.automationWake.containsUntrustedEventText === true ? "" : SAND_TRUSTED_AUTOMATION_PROMPT_MARKER}${text}`;

    const selectedImages = (options.selectedImages ?? []).map((image) => new SelectedImage({
      dataOrBlobId: { case: "data", value: image.data },
      path: image.path ?? "",
      mimeType: image.mimeType ?? "",
    }));
    const selectedVideos = await resolveGeneratedSelectedVideosForTurn(options.selectedVideos ?? []);
    const selectedContext = selectedImages.length > 0 || selectedVideos.length > 0
      ? new SelectedContext({ selectedImages, selectedVideos })
      : undefined;
    const richText = options.richText?.trim();
    const collect = async () => host.shellWatchHost != null
      ? await collectPrependUserMessages(host.shellWatchHost(), options.recentUserMessages, options.messageId)
      : [...await host.collectGeneratedPrependUserMessages?.(options.recentUserMessages ?? [], options.messageId) ?? []];
    const prepended = await (host.traceSendPhase == null
      ? collect()
      : host.traceSendPhase(args.runCtx, "collectPrependUserMessages", collect));
    const unanswered = [...(options.skippedQuestionPrompts ?? []), ...(options.dismissedQuestionPrompts ?? [])];
    if (unanswered.length > 0) prepended.push(new UserMessage({ text: `Unanswered questions:\n${unanswered.map((question) => `- ${question}`).join("\n")}` }));
    const userMessage = new UserMessage({
      text,
      messageId: options.messageId ?? "",
      ...(richText != null && richText.length > 0 ? { richText } : {}),
      ...(selectedContext == null ? {} : { selectedContext }),
    });
    const action = new ConversationAction({
      action: {
        case: "userMessageAction",
        value: new UserMessageAction({ userMessage, prependUserMessages: prepended }),
      },
    });
    return { action, automationStatusReminder: reminder, automationStatusCompactionEpoch: epoch };
  }

  return {
    getLatestAgentProfileUpdate, getAutomationStatusReminderForTurn, getMcpCustomInstructionsSection,
    getMcpDiscoveryStatusSection, resolveMcpCustomInstructions, appendProfileUpdateToHistory,
    getRemoteBoxSection, getComputerUseRemoteBoxSection, getBrowserUseRemoteBoxSection, getComputerSection,
    spotlightEnabled: () => host.isSpotlightEnabled?.() !== false,
    readBoxVideoBytes, resolveSelectedVideosForTurn,
    assembleGeneratedTurnAction,
    noteAutomationStatusReminder(reminder: string, compactionEpoch: number) { lastAutomationStatusReminder = reminder; lastAutomationStatusCompactionEpoch = compactionEpoch; },
    resetAutomationStatusReminder() { lastAutomationStatusReminder = undefined; lastAutomationStatusCompactionEpoch = undefined; },
    assembleTurnAction,
  };
}
