import { jsx } from "../../../../../prompt-jsx/jsx-runtime.js";
import { renderContent } from "../../../../../prompt-jsx/render.js";
import { lenientNumber } from "../../../lenient-number.js";
import { getRequiredPermissionsSchema, type SandboxNetworkInfo } from "./sandbox-shared.js";
import { SandboxingDescriptionBody } from "./sandbox-description.js";
import { getTmuxBackedShellSessionsSectionText } from "../../../../prompts/tmux-backed-shell-instructions.js";
import { z } from "zod";

export interface Dsv3ShellDescriptionOptions {
  readonly isReadonly?: boolean | undefined;
  readonly enableBlockUntilMs?: boolean | undefined;
  readonly enableTmuxGuidance?: boolean | undefined;
  readonly sandboxNetworkInfo?: SandboxNetworkInfo | undefined;
  readonly awaitToolName?: string | undefined;
  readonly readToolName?: string | undefined;
  readonly tmuxSharedSessionName?: string | undefined;
  readonly useMinimalHarness?: boolean | undefined;
  readonly requireBlockUntilMs?: boolean | undefined;
  readonly defaultBlockUntilMs?: number | undefined;
  readonly enableJobCompletionNotifications?: boolean | undefined;
  readonly enableJobProgressNotifications?: boolean | undefined;
  readonly enableTerminalFiles?: boolean | undefined;
}

const baseDescriptionDsv3 = `PROPOSE a command to run on behalf of the user.
If you have this tool, note that you DO have the ability to run commands directly on the USER's system.
Note that the user may have to approve the command before it is executed.
The user may reject it if it is not to their liking, or may modify the command before approving it.  If they do change it, take those changes into account.
In using these tools, adhere to the following guidelines:
1. Based on the contents of the conversation, you will be told if you are in the same shell as a previous step or a different shell.
2. If in a new shell, you should \`cd\` to the appropriate directory and do necessary setup in addition to running the command. By default, the shell will initialize in the project root.
3. If in the same shell, LOOK IN CHAT HISTORY for your current working directory.
4. For ANY commands that would require user interaction, ASSUME THE USER IS NOT AVAILABLE TO INTERACT and PASS THE NON-INTERACTIVE FLAGS (e.g. --yes for npx).
5. If the command would use a pager, append \` | cat\` to the command.
6. For commands that are long running/expected to run indefinitely until interruption, please run them in the background. To run jobs in the background, set \`is_background\` to true rather than changing the details of the command.
7. Dont include any newlines in the command.`;

const baseDescriptionDsv31205 = `Executes a given command in a shell session with optional timeout.
Before executing the command, please follow these steps:
1. Check for Running Processes:
   - Before starting dev servers or long-running processes that should not be duplicated, search the terminals folder to check if they are already running in existing terminals.
   - You can use this information to determine which terminal, if any, matches the command you want to run, contains the output from the command you want to inspect, or has changed since you last read them.
   - Since these are text files, you can read any terminal's contents simply by reading the file, search using the grep tool, etc.
2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")
   - Examples of proper quoting:
     - cd "/Users/name/My Documents" (correct)
     - cd /Users/name/My Documents (incorrect - will fail)
     - python "/path/with spaces/script.py" (correct)
     - python /path/with spaces/script.py (incorrect - will fail)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.
Usage notes:
- The command argument is required.
- You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 30000ms (30 seconds).
- It is very helpful if you write a clear, concise description of what this command does in 5-10 words.
- VERY IMPORTANT: You MUST avoid using search commands like \`find\` and \`grep\`. Instead use Grep, Glob to search. You MUST avoid read tools like \`cat\`, \`head\`, and \`tail\`, and use Read to read files.
- If you _still_ need to use \`grep\`, STOP. ALWAYS USE ripgrep at \`rg\` first, which all users have pre-installed.
- When issuing multiple commands, use the ';' or '&&' operator to separate them. DO NOT use newlines (newlines are ok in quoted strings).
- Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it.<good-example>pytest /foo/bar/tests</good-example><bad-example>cd /foo/bar && pytest tests</bad-example>`;

const notifyOnOutputSchema = z.object({
  pattern: z.string().describe("Regex pattern matched against stdout/stderr output. Output redirected only to a file will not trigger it. Do not match all outputs."),
  reason: z.string().describe("5 or less words describing why you are watching for this output. The UI (only visible to user) will prefix it as 'Monitored `reason`'."),
  debounce_ms: z.number().optional().describe("Milliseconds that must elapse between notifications. The harness enforces a minimum of 5000ms."),
}).optional().describe("Optional output notification config. Each terminal output which matches the pattern will notify you. ONLY set this when the user explicitly requests monitoring.");

function formatBlockUntilDefaultForDescription(ms: number): string {
  const sec = ms / 1e3;
  return Number.isInteger(sec) ? `${sec}s` : `${ms}ms`;
}

function formatBlockUntilMsDefaultForSchema(ms: number): string {
  const sec = ms / 1e3;
  if (Number.isInteger(sec) && sec > 0 && sec <= 120) return `${ms}ms (${sec} second${sec === 1 ? "" : "s"})`;
  const min = ms / 6e4;
  if (Number.isInteger(min) && min >= 1) return `${ms}ms (${min} minute${min === 1 ? "" : "s"})`;
  return `${ms}ms`;
}

function blockUntilMsDescriptionOptional(defaultBlockUntilMs: number): string {
  return `How long to block and wait for the command to complete before moving it to background (in milliseconds). Defaults to ${formatBlockUntilMsDefaultForSchema(defaultBlockUntilMs)}. Set to 0 to immediately run the command in the background. The timer includes the shell startup time.`;
}

const blockUntilMsDescriptionRequired = "How long to block and wait for the command to complete before moving it to background (in milliseconds). Set to 0 to immediately run the command in the background. The timer includes the shell startup time.";

const baseParametersSchemaDsv3 = z.object({
  command: z.string().describe("The terminal command to execute"),
  is_background: z.boolean().describe("Whether the command should be run in the background"),
  explanation: z.string().optional().describe("One sentence explanation as to why this command needs to be run and how it contributes to the goal."),
});

const descriptionSchema = z.string().optional().describe(`Clear, concise description of what this command does in 5-10 words. Examples:
Input: ls
Output: Lists files in current directory

Input: git status
Output: Shows working tree status

Input: npm install
Output: Installs package dependencies

Input: mkdir foo
Output: Creates directory 'foo'`);

const baseParametersSchemaDsv31205 = z.object({
  command: z.string().describe("The command to execute"),
  working_directory: z.string().optional().describe("The absolute path to the working directory to execute the command in (defaults to current directory)"),
  timeout: lenientNumber().optional().describe("Timeout in milliseconds (defaults to 30000ms/30s)"),
  description: descriptionSchema,
  is_background: z.boolean().optional().describe("Whether the command should be run in the background"),
});

const baseParametersSchemaDsv31205WithBlockUntilShared = z.object({
  command: z.string().describe("The command to execute"),
  working_directory: z.string().optional().describe("The absolute path to the working directory to execute the command in (defaults to current directory)"),
  description: descriptionSchema,
});

function baseParametersSchemaDsv31205WithBlockUntilOptional(defaultBlockUntilMs: number) {
  return baseParametersSchemaDsv31205WithBlockUntilShared.extend({ block_until_ms: lenientNumber().optional().describe(blockUntilMsDescriptionOptional(defaultBlockUntilMs)) });
}

const baseParametersSchemaDsv31205WithBlockUntilRequired = baseParametersSchemaDsv31205WithBlockUntilShared.extend({ block_until_ms: lenientNumber().describe(blockUntilMsDescriptionRequired) });
const baseParametersSchemaDsv30226 = baseParametersSchemaDsv31205WithBlockUntilShared.extend({
  block_until_ms: lenientNumber().optional().describe("How long to block and wait for the command to complete before moving it to background (in milliseconds). Defaults to 30000ms (30 seconds). Set to 0 to immediately run the command in the background. Make sure to set `block_until_ms` to higher than the command's expected runtime. Add some buffer since block_until_ms includes shell startup time. E.g. if you sleep for 40s, recommended `block_until_ms` is 45s. Do not specify a 'timeout' parameter; no such param exists."),
});

export function getDescriptionDsv3(sandboxEnabled: boolean, version: string, options: Dsv3ShellDescriptionOptions = {}): string {
  const { isReadonly, enableBlockUntilMs, enableTmuxGuidance, sandboxNetworkInfo, awaitToolName, readToolName, tmuxSharedSessionName, useMinimalHarness, requireBlockUntilMs, defaultBlockUntilMs, enableJobCompletionNotifications, enableJobProgressNotifications, enableTerminalFiles } = options;
  const outputNotificationSection = enableJobProgressNotifications === true ? "You can monitor commands by configuring `notify_on_output`. You will be notified at the end of your turn whenever stdout/stderr output matches the regex `pattern`. Output redirected only to a file will not trigger it. Configure a 5-or-fewer-word `reason` explaining what you are watching for, and optionally configure `debounce_ms`." : undefined;
  const sandboxDescription = sandboxEnabled ? renderContent(SandboxingDescriptionBody({ isReadonly: isReadonly === true, sandboxNetworkInfo })) : undefined;
  const tmuxGuidanceSection = enableTmuxGuidance === true ? getTmuxBackedShellSessionsSectionText({ ...(tmuxSharedSessionName === undefined ? {} : { sharedSessionName: tmuxSharedSessionName }) }) : undefined;
  const fileToolsSection = readToolName === undefined ? undefined : `Use ${readToolName} for file reads and searches instead of shell text processing.`;
  const terminalFilesSection = enableTerminalFiles === true ? "Large output is saved to a terminal file; do not truncate it with head, tail, or sed solely to limit the response." : undefined;
  const appendDescriptionSections = (base: string): string => {
    const sections = [fileToolsSection, terminalFilesSection, tmuxGuidanceSection, sandboxDescription].filter((section): section is string => section !== undefined);
    return sections.length === 0 ? base : `${base}\n\n${sections.join("\n\n")}`;
  };
  if (useMinimalHarness === true) {
    const minimalHarnessDescription = `Execute shell commands in the workspace.\n\n- The shell is stateful - cwd & env vars persist for subsequent calls.\n- Make efficient use of shell calls and minimize wasted tokens.\n- Batch related shell work together or run independent checks in parallel when safe. Make liberal use of \`&&\`, \`;\`, pipes, greps and other efficient shell use.\n- Use targeted, output-limited terminal commands such as \`rg\`, \`head\`, \`tail\`, \`sed -n\`, when relevant to limit output.\n- NEVER use \`set -x\`; it breaks this tool. If it gets set, run \`set +x\` to fix the shell.\n- Optimize for overall cost, including cache reads, cache writes, and output tokens.\n- Use the 'Workspace Path' field in the \`<user_info>\` section to resolve the workspace path. It will likely NOT be at \`/workspace\`; don't waste time trying that.\n- Still do whatever validation is necessary to ensure the judgment is correct; efficiency means avoiding waste, not skipping verification.\n- This may still be a long-running investigation if correctness requires it, but do not spend tokens on status updates, progress narration, or UX niceties while judging.\n- Always quote paths that contain spaces.`;
    const minimalSections = [fileToolsSection, terminalFilesSection, outputNotificationSection, tmuxGuidanceSection].filter((section): section is string => section !== undefined);
    return minimalSections.length === 0 ? minimalHarnessDescription : `${minimalHarnessDescription}\n\n${minimalSections.join("\n\n")}`;
  }
  if (version === "cursor-0226") {
    const base = "Executes a given command in a shell session, waiting for output for `block_until_ms` millis.";
    const baseWithProgress = outputNotificationSection === undefined ? base : `${base}\n\n${outputNotificationSection}`;
    return tmuxGuidanceSection === undefined ? (sandboxEnabled ? `${baseWithProgress}\n${sandboxDescription}` : baseWithProgress) : appendDescriptionSections(baseWithProgress);
  }
  if (version === "dsv3-1205") {
    const outputNotificationBullet = outputNotificationSection === undefined ? "" : `\n- ${outputNotificationSection}`;
    if (enableBlockUntilMs === true) {
      const monitoringSection = !awaitToolName ? `\n- Monitoring backgrounded commands:\n  - When command moves to background, check status immediately by reading the terminal file.\n  - Header has \`pid\` and \`running_for_ms\` (updated every 5000ms)\n  - When finished, footer with \`exit_code\` and \`elapsed_ms\` appears.\n  - Poll repeatedly to monitor by sleeping between checks. If the file gets large, read from the end of the file to capture the latest content.\n  - Pick your sleep intervals using best guess/judgment based on any knowledge you have about the command and its expected runtime, and when no new output, exponential backoff is a good strategy (e.g. 2000ms, 4000ms, 8000ms, 16000ms...), using educated guess for min and max wait.\n  - If it's longer than expected and the command seems like it is hung, kill the process if safe to do so using the pid that appears in the header. If possible, try to fix the hang and proceed.\n  - Don't stop polling until: (a) \`exit_code\` footer appears (terminating command), (b) the command reaches a healthy steady state (only for non-terminating command, e.g. dev server/watcher), or (c) command is hung - follow guidance above.` : enableJobCompletionNotifications ? `\n- You'll be notified when the backgrounded command completes. Only poll with \`${awaitToolName}\` when the command requires close monitoring — long-running jobs that can silently hang or degrade before completing (training runs, evals, deployments, long builds, datagen pipelines, DB migrations, large data transfers). For fire-and-forget commands (tests, installs, dev servers/watchers, short scripts), start them and keep working — you can always poll with \`${awaitToolName}\` later if you end up blocked on the result.` : `\n- Use \`${awaitToolName}\` to monitor the background command.`;
      const blockUntilSection = `Managing long-running commands:\n- Commands that don't complete within \`block_until_ms\`${requireBlockUntilMs ? "" : ` (default ${formatBlockUntilDefaultForDescription(defaultBlockUntilMs ?? 3e4)})`} are moved to background. The command keeps running and output streams to a terminal file. Set \`block_until_ms: 0\` to immediately background (use for dev servers, watchers, or any long-running process).\n- You do not need to use '&' at the end of commands.\n- Make sure to set \`block_until_ms\` to higher than the command's expected runtime. Add some buffer since block_until_ms includes shell startup time; increase buffer next time based on \`elapsed_ms\` if you chose too low. E.g. if you sleep for 40s, recommended \`block_until_ms\` is 45s.\n${monitoringSection}${outputNotificationBullet}`;
      return appendDescriptionSections(`${baseDescriptionDsv31205}\n\n${blockUntilSection}`);
    }
    return appendDescriptionSections(outputNotificationSection === undefined ? baseDescriptionDsv31205 : `${baseDescriptionDsv31205}\n- ${outputNotificationSection}`);
  }
  return appendDescriptionSections(baseDescriptionDsv3);
}

export function getParametersSchemaDsv3(sandboxEnabled: boolean, version: string, options: Dsv3ShellDescriptionOptions & { readonly strictArgParsing?: boolean } = {}): z.ZodObject<z.ZodRawShape> {
  const { isReadonly, enableBlockUntilMs, strictArgParsing, requireBlockUntilMs, defaultBlockUntilMs, enableJobProgressNotifications } = options;
  const addOptionalParameters = (schema: z.ZodObject<z.ZodRawShape>): z.ZodObject<z.ZodRawShape> => {
    let nextSchema = schema;
    if (enableJobProgressNotifications === true) nextSchema = nextSchema.extend({ notify_on_output: notifyOnOutputSchema });
    if (sandboxEnabled) nextSchema = nextSchema.extend({ required_permissions: getRequiredPermissionsSchema({ isReadonly: isReadonly === true, strict: strictArgParsing === true }) });
    return nextSchema;
  };
  if (version === "dsv3-1205" || version === "cursor-0226") {
    if (enableBlockUntilMs === true) {
      const blockUntilSchema = version === "cursor-0226" && requireBlockUntilMs !== true
        ? baseParametersSchemaDsv30226
        : requireBlockUntilMs === true
          ? baseParametersSchemaDsv31205WithBlockUntilRequired
          : baseParametersSchemaDsv31205WithBlockUntilOptional(defaultBlockUntilMs ?? 3e4);
      return addOptionalParameters(blockUntilSchema);
    }
    return addOptionalParameters(baseParametersSchemaDsv31205);
  }
  return addOptionalParameters(baseParametersSchemaDsv3);
}

export { notifyOnOutputSchema };
