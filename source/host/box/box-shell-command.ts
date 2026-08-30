import { ShellArgs, ShellCommandParsingResult, ShellCommandParsingResult_ExecutableCommand } from "../../packages/proto/generated/agent/v1/shell_exec_pb.js";

export interface HostShellArgsInput { command: string; name: string; workingDirectory: string; toolCallId: string }
export type HostShellArgs = ShellArgs;
export function buildHostShellArgs({ command, name, workingDirectory, toolCallId }: HostShellArgsInput): HostShellArgs { return new ShellArgs({ command, workingDirectory, toolCallId, skipApproval: true, parsingResult: new ShellCommandParsingResult({ parsingFailed: false, executableCommands: [new ShellCommandParsingResult_ExecutableCommand({ name, args: [], fullText: command })], hasRedirects: false, hasCommandSubstitution: false }) }); }
