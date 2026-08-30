import { SandboxPolicy_Type } from "../../../../proto/generated/agent/v1/sandbox_pb.js";
import { ShellAbortReason, ShellBackgroundReason } from "../../../../proto/generated/agent/v1/shell_exec_pb.js";
import { ASK_MODE_MODEL_ERROR, truncateOutput } from "../../common.js";
import { buildToolCallExecutionTimedOutMessage } from "../../tool-execution-timeout.js";
import { analyzeFailure } from "./retry-helpers.js";

const SHELL_CHAR_HARD_LIMIT = 2e4;
const SHELL_MISSING_EXIT_ERROR_MESSAGE = "The shell command returned no exit status, so its result is unknown — do not assume it ran or succeeded. If this repeats, the execution environment may need to be restarted.";

interface OutputLocation {
  readonly filePath: string;
  readonly sizeBytes: number | string | bigint;
  readonly lineCount: number | string | bigint;
}

interface SandboxPolicy {
  readonly type: SandboxPolicy_Type;
  readonly allowlistEscalated?: boolean | undefined;
  readonly networkAccess?: boolean | undefined;
  readonly networkPolicy?: { readonly allow?: readonly string[] | undefined } | undefined;
}

interface ShellResult {
  readonly combinedOutput: string;
  readonly exitCode: number;
  readonly executionTimeMs?: number | undefined;
  readonly outputLocation?: OutputLocation | undefined;
  readonly signal?: string | undefined;
  readonly workingDirectory?: string | undefined;
  readonly sandboxPolicy?: SandboxPolicy | undefined;
  readonly command?: string | undefined;
  readonly useMinimalHarness?: boolean | undefined;
}

interface FormatterOptions {
  readonly discourageAwait?: boolean | undefined;
  readonly autoBackgroundedForInterruption?: boolean | undefined;
  readonly promptVersion?: string | undefined;
  readonly sandboxPromptEnabled?: boolean | undefined;
  readonly useMinimalHarness?: boolean | undefined;
}

function formatCompletionMessage(isAborted: boolean, executionTimeMs?: number): string {
  if (isAborted) {
    return executionTimeMs !== undefined ? `Command aborted after ${executionTimeMs} ms.` : "Command aborted.";
  }
  return executionTimeMs !== undefined ? `Command completed in ${executionTimeMs} ms.` : "Command completed.";
}

function formatShellStateMessage(signal?: string, workingDirectory?: string): string {
  if (signal === "SIGTERM") {
    return "The previous shell command aborted, so on the next invocation of this tool, a new shell will be started at the project root.";
  }
  let message = "Shell state (cwd, env vars) persists for subsequent calls.";
  if (workingDirectory?.trim()) {
    message += ` Current directory: ${workingDirectory}`;
  }
  return message;
}

function formatShellResultMinimal(result: ShellResult): string {
  if (result.outputLocation) {
    const totalSize = Number(result.outputLocation.sizeBytes);
    const lineCount = Number(result.outputLocation.lineCount);
    const sizeString = totalSize >= 1024 ? `${(totalSize / 1024).toFixed(1)} KB` : `${totalSize} bytes`;
    let formatted = `Exit code: ${result.exitCode}\n`;
    if (result.executionTimeMs !== undefined) {
      formatted += `Runtime: ${result.executionTimeMs} ms\n`;
    }
    formatted += `Output written to: ${result.outputLocation.filePath} (${sizeString}, ${lineCount} lines)`;
    return formatted;
  }
  const combinedResult = truncateOutput(result.combinedOutput, SHELL_CHAR_HARD_LIMIT, true);
  let formatted = `Exit code: ${result.exitCode}\n`;
  if (result.executionTimeMs !== undefined) {
    formatted += `Runtime: ${result.executionTimeMs} ms\n`;
  }
  formatted += `Output:\n${combinedResult.output}`;
  return formatted;
}

function formatSandboxingReminder(exitCode: number, output: string, sandboxPolicy?: SandboxPolicy, command?: string): string {
  if (!sandboxPolicy) return "";
  if (sandboxPolicy.type === SandboxPolicy_Type.INSECURE_NONE) {
    if (sandboxPolicy.allowlistEscalated) {
      return "\n\nThis command ran outside the sandbox (no restrictions) because it matched the user's command allowlist.";
    }
    return "";
  }
  const isReadonly = sandboxPolicy.type === SandboxPolicy_Type.WORKSPACE_READONLY;
  const hasNetworkAllowlist = sandboxPolicy.networkAccess === true && sandboxPolicy.networkPolicy?.allow !== undefined && sandboxPolicy.networkPolicy.allow.length > 0;
  let result = "";
  result += "\n\nSANDBOXING: This command ran in a sandbox with the following restrictions:";
  if (isReadonly) {
    result += "\n- Filesystem: Read-only access (no file modifications allowed)";
  } else if (sandboxPolicy.type === SandboxPolicy_Type.WORKSPACE_READWRITE) {
    result += "\n- Filesystem: Write access limited to the workspace directory, read access to the rest of the filesystem";
  }
  if (sandboxPolicy.networkAccess !== undefined) {
    if (sandboxPolicy.networkAccess) {
      result += hasNetworkAllowlist ? "\n- Network access: Limited (allowlist only)" : "\n- Network access: Allowed (unrestricted)";
    } else {
      result += "\n- Network access: Blocked";
    }
  }
  const hasNetworkRestriction = sandboxPolicy.networkAccess !== true || hasNetworkAllowlist;
  const commandFailed = exitCode !== 0;
  const failureKind = commandFailed ? analyzeFailure(exitCode, output, command) : undefined;
  if (commandFailed && failureKind === "sandbox" && !isReadonly) {
    result += "\n\nThe command likely failed due to sandbox restrictions (permission denied or access error). You should re-run with required_permissions: [\"all\"] to run outside the sandbox entirely. Don't needlessly ask for permission.";
  } else if (commandFailed && failureKind === "network") {
    result += "\n\nThe command likely failed due to network restrictions. You should re-run with required_permissions: [\"full_network\"] to enable network access. Don't needlessly ask for permission.";
  } else if (!isReadonly) {
    const missingPermissions: string[] = [];
    if (hasNetworkRestriction) missingPermissions.push('"full_network"');
    if (missingPermissions.length > 0) {
      const example = `[${missingPermissions[0]}]`;
      result += `\nIf you think the command failed due to sandbox restrictions, re-run with the required_permissions that you need (such as ${example}) or use required_permissions: ["all"] to run outside the sandbox entirely. Don't needlessly ask for permission.`;
    } else {
      result += "\nIf you think the command failed due to sandbox restrictions, re-run with required_permissions: [\"all\"] to run outside the sandbox entirely. Don't needlessly ask for permission.";
    }
  }
  return result;
}

function formatShellResultMinimalOrFull(result: ShellResult): string {
  if (result.useMinimalHarness) return formatShellResultMinimal(result);
  if (result.outputLocation) {
    const totalSize = Number(result.outputLocation.sizeBytes);
    const lineCount = Number(result.outputLocation.lineCount);
    const sizeString = totalSize >= 1024 ? `${(totalSize / 1024).toFixed(1)} KB` : `${totalSize} bytes`;
    const isAborted = result.signal === "SIGTERM";
    let formatted = `Exit code: ${result.exitCode}\n\n`;
    formatted += `Command output has been written to: ${result.outputLocation.filePath} (${sizeString}, ${lineCount} lines)\n\n`;
    formatted += `${formatCompletionMessage(isAborted, result.executionTimeMs)}\n\n`;
    formatted += formatShellStateMessage(result.signal, result.workingDirectory);
    return formatted + formatSandboxingReminder(result.exitCode, result.combinedOutput, result.sandboxPolicy, result.command);
  }
  const combinedResult = truncateOutput(result.combinedOutput, SHELL_CHAR_HARD_LIMIT, true);
  const isAborted = result.signal === "SIGTERM";
  let formatted = `Exit code: ${result.exitCode}\n\n`;
  formatted += `Command output${combinedResult.truncated ? ` (truncated to ${SHELL_CHAR_HARD_LIMIT} characters)` : ""}:\n\n`;
  formatted += `\`\`\`\n${combinedResult.output}\n\`\`\`\n\n`;
  formatted += `${formatCompletionMessage(isAborted, result.executionTimeMs)}\n\n`;
  formatted += formatShellStateMessage(result.signal, result.workingDirectory);
  return formatted + formatSandboxingReminder(result.exitCode, result.combinedOutput, result.sandboxPolicy, result.command);
}

export function formatShellResult(result: ShellResult): string {
  return formatShellResultMinimalOrFull(result);
}

function formatTimeoutResult(partialOutput: string, command: string): string {
  const truncatedOutput = truncateOutput(partialOutput, SHELL_CHAR_HARD_LIMIT, true);
  let formatted = "Command timed out.\n\n";
  if (partialOutput.length > 0) {
    formatted += `Partial output before timeout${truncatedOutput.truncated ? ` (truncated to ${SHELL_CHAR_HARD_LIMIT} characters)` : ""}:\n\n`;
    formatted += `\`\`\`\n${truncatedOutput.output}\n\`\`\`\n\n`;
  }
  formatted += `The command "${command}" did not complete within the timeout period. The shell has been terminated.\n\n`;
  return `${formatted}On the next invocation of this tool, a new shell will be started at the project root.`;
}

export function formatShellPartialOutputSection(partialOutput: string, options: { readonly heading: string; readonly truncatedSuffix?: string; readonly emptyMessage?: string }): string {
  if (partialOutput.length === 0) return options.emptyMessage ?? "";
  const truncatedOutput = truncateOutput(partialOutput, SHELL_CHAR_HARD_LIMIT, true);
  return `${options.heading}${truncatedOutput.truncated ? options.truncatedSuffix ?? " (truncated)" : ""}:\n\n\`\`\`\n${truncatedOutput.output}\n\`\`\``;
}

export function formatShellMissingExitDisplay(interleavedOutput: string): string {
  const partialSection = formatShellPartialOutputSection(interleavedOutput, {
    heading: "Output collected before the stream closed",
    truncatedSuffix: ` (truncated to ${SHELL_CHAR_HARD_LIMIT} characters)`
  });
  return partialSection.length === 0 ? SHELL_MISSING_EXIT_ERROR_MESSAGE : `${SHELL_MISSING_EXIT_ERROR_MESSAGE}\n\n${partialSection}`;
}

function formatUserManuallyBackgroundedToolMessage(toolNoun: string, elapsedMs?: number, options?: { readonly discourageAwait?: boolean | undefined }): string {
  const elapsedText = elapsedMs !== undefined ? ` after ${elapsedMs}ms` : "";
  const awaitGuidance = options?.discourageAwait === true ? " Do NOT await it; either continue with other work or end your turn." : "";
  return `The user manually backgrounded the ${toolNoun}${elapsedText}.${awaitGuidance}`;
}

function formatAutoBackgroundedForInterruptionToolMessage(toolNoun: string, elapsedMs?: number): string {
  const elapsedText = elapsedMs !== undefined ? ` after ${elapsedMs}ms` : "";
  return `The ${toolNoun} was automatically backgrounded${elapsedText} because the user interrupted the chat. Consider killing the shell command if it should no longer run after the user's interruption.`;
}

function formatBackgroundedResult(partialOutput: string, shellId: number, outputPath: string, pid?: number, msToWait?: number, backgroundReason?: ShellBackgroundReason, options?: FormatterOptions): string {
  if (msToWait !== undefined) {
    const intro = backgroundReason === ShellBackgroundReason.USER_REQUEST
      ? `${options?.autoBackgroundedForInterruption === true ? formatAutoBackgroundedForInterruptionToolMessage("command", msToWait) : formatUserManuallyBackgroundedToolMessage("command", msToWait, options)}\n`
      : `The command did not complete in ${msToWait}ms and was sent to the background.\n`;
    let formatted = `${intro}Shell ID: ${shellId}\n`;
    if (pid !== undefined && pid !== 0) formatted += `PID: ${pid}\n`;
    formatted += `The output is being written to ${outputPath}. Don't mention Shell ID to the user.\n\n`;
    return formatted + formatShellPartialOutputSection(partialOutput, {
      heading: "Output collected before backgrounding",
      truncatedSuffix: " (truncated)",
      emptyMessage: "No output was collected before backgrounding."
    });
  }
  let formatted = "Command exceeded block_until_ms and was moved to background.\n\n";
  const partialSection = formatShellPartialOutputSection(partialOutput, {
    heading: "Output before backgrounding",
    truncatedSuffix: ` (truncated to ${SHELL_CHAR_HARD_LIMIT} characters)`,
    emptyMessage: "No output before backgrounding."
  });
  if (partialSection.length > 0) formatted += `${partialSection}\n\n`;
  formatted += `Shell ID: ${shellId}\n`;
  if (pid !== undefined && pid !== 0) formatted += `PID: ${pid}\n`;
  return `${formatted}Output will continue to be written to ${outputPath}. Don't mention Shell ID to the user.`;
}

function formatExecutionTimeoutResult(timeout: { readonly timeoutMs: number; readonly command: string }): string {
  const message = buildToolCallExecutionTimedOutMessage({ toolName: "shell", executionTimeoutMs: timeout.timeoutMs });
  return timeout.command.length > 0 ? `${message}\n\nCommand: ${timeout.command}` : message;
}

interface ShellResultValue {
  readonly command: string;
  readonly interleavedOutput?: string;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly isReadonly?: boolean;
  readonly timeoutMs?: number;
  readonly shellId?: number;
  readonly pid?: number;
  readonly msToWait?: number;
  readonly backgroundReason?: ShellBackgroundReason;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly workingDirectory?: string;
  readonly outputLocation?: OutputLocation;
  readonly localExecutionTimeMs?: number;
  readonly executionTime?: number;
  readonly abortReason?: ShellAbortReason;
  readonly aborted?: boolean;
}

interface ShellResultCase {
  readonly case?: string;
  readonly value: ShellResultValue;
}

interface RenderShellResult {
  readonly result: ShellResultCase;
  readonly sandboxPolicy?: SandboxPolicy;
  readonly isBackground?: boolean;
  readonly terminalsFolder?: string;
}

export function renderShellResultToString(shellResult: RenderShellResult, options: FormatterOptions = {}): string {
  const { result, sandboxPolicy, isBackground, terminalsFolder } = shellResult;
  if (isBackground) {
    switch (result.case) {
      case "success": {
        const shellId = result.value.shellId;
        const pid = result.value.pid;
        const outputPath = terminalsFolder ? `${terminalsFolder}/${shellId}.txt` : `<terminals_folder>/${shellId}.txt`;
        let message = `Background command started successfully.\nShell ID: ${shellId}\n`;
        if (pid !== undefined && pid !== 0) message += `PID: ${pid}\n`;
        return `${message}Command: ${result.value.command}\nOutput will be written to ${outputPath}. Don't mention Shell ID to the user.`;
      }
      case "failure": return result.value.stderr || result.value.stdout || "";
      case "rejected": return "Background command rejected by user";
      case "permissionDenied": return result.value.isReadonly ? ASK_MODE_MODEL_ERROR : `Permission denied: ${result.value.error}`;
      case "timeout": return formatExecutionTimeoutResult({ timeoutMs: result.value.timeoutMs ?? 0, command: result.value.command });
      case "spawnError": {
        const error = result.value.error ?? "";
        if (error.startsWith(SHELL_MISSING_EXIT_ERROR_MESSAGE)) return error;
        return result.value.command.length > 0 ? `Error: Command failed to spawn: ${error}\n\nCommand: ${result.value.command}` : `Error: Command failed to spawn: ${error}`;
      }
      case undefined: return "Unknown error";
      default: throw new Error(`Unhandled result case: ${result.case}`);
    }
  }
  switch (result.case) {
    case "success":
    case "failure": {
      const value = result.value;
      const shellId = result.case === "success" ? value.shellId : undefined;
      const pid = result.case === "success" ? value.pid : undefined;
      const msToWait = result.case === "success" ? value.msToWait : undefined;
      const backgroundReason = result.case === "success" ? value.backgroundReason : undefined;
      const interleavedOutput = value.interleavedOutput;
      if (shellId !== undefined && shellId !== 0) {
        const outputPath = terminalsFolder ? `${terminalsFolder}/${shellId}.txt` : `<terminals_folder>/${shellId}.txt`;
        return formatBackgroundedResult(interleavedOutput ?? "", shellId, outputPath, pid, msToWait, backgroundReason, {
          discourageAwait: options.discourageAwait,
          autoBackgroundedForInterruption: options.autoBackgroundedForInterruption
        });
      }
      const abortReason = result.case === "failure" ? value.abortReason : undefined;
      const wasAborted = result.case === "failure" && value.aborted === true;
      const wasTimeout = abortReason === ShellAbortReason.TIMEOUT;
      const wasUserAborted = abortReason === ShellAbortReason.USER_ABORT || wasAborted && abortReason === undefined;
      if (wasTimeout) return formatTimeoutResult(interleavedOutput ?? "", value.command);
      const formatted = options.promptVersion === "dsv3-1018"
        ? formatShellResultDsv3({ combinedOutput: interleavedOutput ?? "", exitCode: value.exitCode ?? 0, command: value.command, workingDirectory: value.workingDirectory, signal: value.signal, sandboxPolicy }, value.command, { includeSandboxReminder: options.sandboxPromptEnabled })
        : formatShellResult({ combinedOutput: interleavedOutput ?? "", exitCode: value.exitCode ?? 0, outputLocation: value.outputLocation, sandboxPolicy, command: value.command, signal: value.signal, workingDirectory: value.workingDirectory, executionTimeMs: value.localExecutionTimeMs != null ? value.localExecutionTimeMs : value.executionTime, useMinimalHarness: options.useMinimalHarness });
      return wasUserAborted ? `Command was aborted by the user.\n${formatted}` : formatted;
    }
    case "timeout": return formatExecutionTimeoutResult({ timeoutMs: result.value.timeoutMs ?? 0, command: result.value.command });
    case "spawnError": {
      const error = result.value.error ?? "";
      if (error.startsWith(SHELL_MISSING_EXIT_ERROR_MESSAGE)) return error;
      return result.value.command.length > 0 ? `Error: Command failed to spawn: ${error}\n\nCommand: ${result.value.command}` : `Error: Command failed to spawn: ${error}`;
    }
    case "rejected": return `Rejected: ${result.value.reason}`;
    case "permissionDenied": return result.value.isReadonly ? ASK_MODE_MODEL_ERROR : `Permission denied: ${result.value.error}`;
    case undefined: return "Unknown error";
    default: throw new Error(`Unhandled result case: ${result.case}`);
  }
}

export function formatShellResultDsv3(result: ShellResult, originalCommand: string, options?: { readonly includeSandboxReminder?: boolean | undefined }): string {
  const executedCommand = result.command ?? originalCommand;
  const outputWithCommand = `${executedCommand}\n${result.combinedOutput.replace(/\n+$/, "")}`;
  const isTruncated = outputWithCommand.length > SHELL_CHAR_HARD_LIMIT;
  const displayedOutput = isTruncated ? outputWithCommand.slice(0, SHELL_CHAR_HARD_LIMIT) : outputWithCommand;
  let formatted = `Exit code: ${result.exitCode}\n\n`;
  formatted += `Command output${isTruncated ? ` (truncated to ${SHELL_CHAR_HARD_LIMIT} characters)` : ""}:\n\n`;
  formatted += `\`\`\`\n${displayedOutput}\n\`\`\`\n\n`;
  formatted += `Command ${result.signal === "SIGTERM" ? "aborted" : "completed"}.\n\n`;
  if (result.signal === "SIGTERM") {
    formatted += "The previous shell command aborted, so on the next invocation of this tool, a new shell will be started at the project root.";
  } else {
    formatted += "The previous shell command ended, so on the next invocation of this tool, you will be reusing the shell.";
    if (result.workingDirectory?.trim()) formatted += `\n\nOn the next terminal tool call, the directory of the shell will already be ${result.workingDirectory}.`;
  }
  if (options?.includeSandboxReminder) formatted += formatSandboxingReminder(result.exitCode, result.combinedOutput, result.sandboxPolicy, result.command);
  return formatted;
}
