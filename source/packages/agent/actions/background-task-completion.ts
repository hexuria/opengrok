import {
  BackgroundTaskCompletion,
  BackgroundTaskCompletionReason,
  BackgroundTaskKind,
  BackgroundTaskNotificationContext,
  BackgroundTaskStatus,
} from "../../proto/generated/agent/v1/agent_pb.js";
import { SYSTEM_NOTIFICATION_TAG } from "../../constants/system-notification.js";
import { META_PARENT_COMPLETION_CLOSE_TAG, META_PARENT_COMPLETION_OPEN_TAG, META_PARENT_COMPLETION_SYSTEM_REMINDER } from "../utils/meta-parent-completion-protocol.js";
import { escapePromptXmlText } from "../utils/prompt-xml-escape.js";
import { buildTimestampPrefix } from "../state.js";
import { jsx, jsxs, type PromptProps, type PromptNode } from "../../prompt-jsx/jsx-runtime.js";
import { renderContent } from "../../prompt-jsx/render.js";

export const SUBAGENT_NOTIFICATION_VISIBLE_SUMMARY_LEAD = "The beginning of the above subagent result is already visible to the user.";
const SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_WITH_VISIBLE_SUMMARY_BASE = `${SUBAGENT_NOTIFICATION_VISIBLE_SUMMARY_LEAD} Perform any follow-up actions (if needed). DO NOT regurgitate or reiterate its result unless asked. If multiple subagents have now completed and none are still running, briefly summarize the findings and conclusions across all of them. Otherwise, if no follow-ups remain, end your response with a brief third-person confirmation that the subagent has completed.`;
const SUBAGENT_NOTIFICATION_HIDDEN_SUMMARY_LEAD = "Perform any necessary follow-up actions in response to the subagent completion above.";
const SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_HIDDEN_SUMMARY_BASE = `${SUBAGENT_NOTIFICATION_HIDDEN_SUMMARY_LEAD} If no follow-up work is needed, no further action is required.`;
const SUBAGENT_NOTIFICATION_CHAT_LINK_INSTRUCTION = " If you mention an agent or subagent in your response, link it with the `[label](id)` format using the agent_id or task_id from the notification instead of printing the raw ID.";
const SUBAGENT_NOTIFICATION_NAMED_LINK_INSTRUCTION = " If you mention an agent or subagent in your response, link it with the `[Name](id)` Don't use generic label such as `[agent]`, `[worker]`, or `[subagent]`.";
const SUBAGENT_NOTIFICATION_CLOUD_VIEW_LINK_INSTRUCTION = " For cloud subagents, when the agent has edited code, link to `[Review](bc-id#changes)`, or, if you know the exact added and deleted line counts, `[Review +A −D](bc-id#changes)`, replacing A and D with the actual counts. Never write A or D literally. Use `[Try Live](bc-id#desktop)` only when the agent used computer use.";
const SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_SUFFIX = " Don't repeat the same confirmation every time.";
const USER_DRIVEN_INTERACTIVE_CHILD_LEAD = "The user is actively driving this Project child.";
const USER_DRIVEN_INTERACTIVE_CHILD_ACKNOWLEDGEMENT_USER_QUERY_BASE = `${USER_DRIVEN_INTERACTIVE_CHILD_LEAD} Record the completion for coordination, but do not message the user or take over the child thread. If no coordinator bookkeeping is required, end without further action.`;
const SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_BASE = "Briefly inform the user about the task result and perform any follow-up actions (if needed).";
const SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY = `<user_query>${SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_BASE}</user_query>`;
const COMPOSER_SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY = `<user_query>${SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_BASE} If there's no follow-ups needed, don't explicitly say that.</user_query>`;

export interface BackgroundCompletionFormatOptions {
  readonly timeZone?: string;
  readonly includeTimestamp: boolean;
  readonly parentModelInfo?: { readonly isComposer1?: boolean; readonly isComposer15?: boolean; readonly isComposer2?: boolean; readonly isComposerMatterhorn?: boolean };
  readonly enableAgentChatLinks: boolean;
  readonly hideAsyncSubagentTaskNotifications: boolean;
  readonly includeCloudSubagentViewLinks: boolean;
}

function wrapUserQuery(inner: string): string { return `<user_query>${inner}</user_query>`; }

export function neutralizeBackgroundTaskDetailCloseTags(detail: string): string {
  return detail.replace(/<\/\s*(task|system_notification)\s*>/gi, "&lt;/$1>").replace(/<(\/?)\s*user_query\s*>/gi, "&lt;$1user_query>");
}

export function getShellNotificationAcknowledgementUserQuery(parentModelInfo: BackgroundCompletionFormatOptions["parentModelInfo"]): string {
  if (parentModelInfo?.isComposer1 || parentModelInfo?.isComposer15 || parentModelInfo?.isComposer2 || parentModelInfo?.isComposerMatterhorn) return COMPOSER_SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY;
  return SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY;
}

export function getNotificationAcknowledgementUserQuery(
  completions: readonly BackgroundTaskCompletion[],
  opts: BackgroundCompletionFormatOptions,
): string {
  if (completions.length > 0 && completions.every(completion => completion.notificationContext === BackgroundTaskNotificationContext.USER_DRIVEN_INTERACTIVE_CHILD)) return wrapUserQuery(`${USER_DRIVEN_INTERACTIVE_CHILD_ACKNOWLEDGEMENT_USER_QUERY_BASE}${SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_SUFFIX}`);
  for (const completion of completions) {
    if (completion.kind === BackgroundTaskKind.SUBAGENT) {
      const basePrompt = opts.hideAsyncSubagentTaskNotifications ? SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_HIDDEN_SUMMARY_BASE : SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_WITH_VISIBLE_SUMMARY_BASE;
      let chatLinkInstruction = "";
      if (opts.enableAgentChatLinks) {
        if (opts.hideAsyncSubagentTaskNotifications) {
          chatLinkInstruction = SUBAGENT_NOTIFICATION_NAMED_LINK_INSTRUCTION;
          if (opts.includeCloudSubagentViewLinks) chatLinkInstruction += SUBAGENT_NOTIFICATION_CLOUD_VIEW_LINK_INSTRUCTION;
        } else chatLinkInstruction = SUBAGENT_NOTIFICATION_CHAT_LINK_INSTRUCTION;
      }
      return wrapUserQuery(`${basePrompt}${chatLinkInstruction}${SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_SUFFIX}`);
    }
  }
  return getShellNotificationAcknowledgementUserQuery(opts.parentModelInfo);
}

export function backgroundTaskKindLabel(kind: BackgroundTaskKind): string {
  switch (kind) {
    case BackgroundTaskKind.SHELL: return "shell";
    case BackgroundTaskKind.SUBAGENT: return "subagent";
    case BackgroundTaskKind.UNSPECIFIED: return "unknown";
    default: return "unknown";
  }
}

export function backgroundTaskStatusLabel(status: BackgroundTaskStatus): string {
  switch (status) {
    case BackgroundTaskStatus.SUCCESS: return "success";
    case BackgroundTaskStatus.ERROR: return "error";
    case BackgroundTaskStatus.ABORTED: return "aborted";
    case BackgroundTaskStatus.UNSPECIFIED: return "unknown";
    default: return "unknown";
  }
}

function BackgroundCompletionsPrompt(props: PromptProps): PromptNode {
  const completions = Array.isArray(props.completions)
    ? props.completions.filter((value): value is BackgroundTaskCompletion => value instanceof BackgroundTaskCompletion)
    : [];
  const allCompletionsAreShellOutputProgress = completions.length > 0 && completions.every(isShellOutputCompletion);
  const intro = allCompletionsAreShellOutputProgress
    ? completions.length === 1 ? "The following task has notified. If you were already aware, ignore this notification and do not restate prior responses." : "The following tasks notified. If you were already aware, ignore this notification and do not restate prior responses."
    : completions.length === 1 ? "The following task has finished. If you were already aware, ignore this notification and do not restate prior responses." : "The following tasks finished. If you were already aware, ignore this notification and do not restate prior responses.";
  return jsxs("section", { title: SYSTEM_NOTIFICATION_TAG, children: [jsx("p", { children: intro }), completions.map((completion, index) => {
    const lines = [
      `kind: ${backgroundTaskKindLabel(completion.kind)}`,
      `status: ${backgroundTaskStatusLabel(completion.status)}`,
      ...(completion.reason === BackgroundTaskCompletionReason.WORKER_REPARENTED ? ["reason: worker_reparented"] : []),
      `task_id: ${escapePromptXmlText(completion.taskId)}`,
      `title: ${escapePromptXmlText(completion.title)}`,
      ...(completion.toolCallId ? [`tool_call_id: ${escapePromptXmlText(completion.toolCallId)}`] : []),
      ...(completion.subagentId ? [`agent_id: ${escapePromptXmlText(completion.subagentId)}`] : []),
      ...(completion.detail ? [`detail: ${neutralizeBackgroundTaskDetailCloseTags(completion.detail)}`] : []),
      ...(completion.outputPath ? [`output_path: ${escapePromptXmlText(completion.outputPath)}`] : []),
    ];
    return jsx("section", { title: "task", children: lines.join("\n") }, index);
  })] });
}

export function formatBackgroundCompletions(completions: readonly BackgroundTaskCompletion[], opts: BackgroundCompletionFormatOptions): string {
  const prefix = opts.includeTimestamp ? buildTimestampPrefix(opts.timeZone) : "";
  const body = renderContent(jsx(BackgroundCompletionsPrompt, { completions }));
  return `${prefix}${body}\n${getNotificationAcknowledgementUserQuery(completions, opts)}`;
}

export function formatMetaParentBackgroundCompletions(completions: readonly BackgroundTaskCompletion[], opts: BackgroundCompletionFormatOptions): string {
  const normalizeResponseBody = (rawText: string): string => {
    const trimmedText = escapePromptXmlText(rawText.trim());
    return ["<response>", trimmedText.length > 0 ? trimmedText : "No output", "</response>"].join("\n");
  };
  const prefix = opts.includeTimestamp ? buildTimestampPrefix(opts.timeZone) : "";
  const body = completions.map(completion => {
    const includeSubagentResult = completion.kind !== BackgroundTaskKind.SUBAGENT || opts.hideAsyncSubagentTaskNotifications;
    const rawResultText = includeSubagentResult ? completion.detail ?? completion.outputPath ?? completion.title ?? "No result was provided." : "Subagent completed; result is already visible to the user.";
    const titleLine = completion.title && includeSubagentResult ? `title: ${escapePromptXmlText(completion.title)}\n` : "";
    return `${META_PARENT_COMPLETION_OPEN_TAG}\nagent_id: ${escapePromptXmlText(completion.taskId)}\nstatus: ${backgroundTaskStatusLabel(completion.status)}\n${titleLine}response:\n${normalizeResponseBody(rawResultText)}\n${META_PARENT_COMPLETION_CLOSE_TAG}`;
  }).join("\n\n");
  return `${prefix}${META_PARENT_COMPLETION_SYSTEM_REMINDER}\n\n${body}\n${getNotificationAcknowledgementUserQuery(completions, opts)}`;
}

export function summarizeBackgroundTaskCompletions(completions: readonly BackgroundTaskCompletion[]): {
  readonly num_completions: number;
  readonly kind_counts: { readonly shell: number; readonly subagent: number; readonly unknown: number };
  readonly status_counts: { readonly success: number; readonly error: number; readonly aborted: number; readonly unknown: number };
} {
  const kindCounts = { shell: 0, subagent: 0, unknown: 0 };
  const statusCounts = { success: 0, error: 0, aborted: 0, unknown: 0 };
  for (const completion of completions) {
    if (completion.kind === BackgroundTaskKind.SHELL) kindCounts.shell += 1;
    else if (completion.kind === BackgroundTaskKind.SUBAGENT) kindCounts.subagent += 1;
    else kindCounts.unknown += 1;
    if (completion.status === BackgroundTaskStatus.SUCCESS) statusCounts.success += 1;
    else if (completion.status === BackgroundTaskStatus.ERROR) statusCounts.error += 1;
    else if (completion.status === BackgroundTaskStatus.ABORTED) statusCounts.aborted += 1;
    else statusCounts.unknown += 1;
  }
  return { num_completions: completions.length, kind_counts: kindCounts, status_counts: statusCounts };
}

export function isShellOutputCompletion(completion: BackgroundTaskCompletion): boolean {
  return completion.reason === BackgroundTaskCompletionReason.TASK_PROGRESS;
}

export function getBackgroundTaskCompletionMetadata(completions: readonly BackgroundTaskCompletion[]): { readonly title?: string; readonly taskId?: string } | undefined {
  const metadata = completions.map(completion => {
    const title = completion.title.trim();
    const taskId = completion.taskId.trim();
    if (title.length === 0 && taskId.length === 0) return undefined;
    return { ...(title.length > 0 ? { title } : {}), ...(taskId.length > 0 ? { taskId } : {}) };
  }).find(value => value !== undefined);
  return metadata;
}

export function getBackgroundTaskCompletionThreadId(completions: readonly BackgroundTaskCompletion[], stateHandler: { getSubagentThreadId(taskId: string): string | undefined }): string | undefined {
  let resolvedThreadId: string | undefined;
  for (const completion of completions) {
    const threadId = completion.threadId?.trim() || stateHandler.getSubagentThreadId(completion.taskId);
    if (threadId === undefined || threadId.length === 0) continue;
    if (resolvedThreadId === undefined) resolvedThreadId = threadId;
    else if (threadId !== resolvedThreadId) return undefined;
  }
  return resolvedThreadId;
}
