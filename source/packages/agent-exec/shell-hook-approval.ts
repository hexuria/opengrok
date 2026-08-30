import type { PartialMessage } from "@bufbuild/protobuf";

import {
  ShellHookApprovalRequirement,
  ShellHookApprovalRequirement_Kind,
} from "../proto/generated/agent/v1/shell_exec_pb.js";

interface ShellHookApprovalArgs {
  hookApprovalRequirement?: ShellHookApprovalRequirement | undefined;
}

export function setShellHookApprovalRequirement(
  args: ShellHookApprovalArgs,
  requirement: PartialMessage<ShellHookApprovalRequirement> | undefined,
): void {
  if (requirement === undefined) {
    args.hookApprovalRequirement = undefined;
    return;
  }
  args.hookApprovalRequirement = new ShellHookApprovalRequirement(requirement);
}

export function createForcePromptHookApprovalRequirement(
  reason: string | undefined,
): ShellHookApprovalRequirement {
  return new ShellHookApprovalRequirement({
    kind: ShellHookApprovalRequirement_Kind.FORCE_PROMPT,
    reason: reason!,
  });
}

export function getShellHookApprovalRequirement(
  args: ShellHookApprovalArgs,
): ShellHookApprovalRequirement | undefined {
  return args.hookApprovalRequirement;
}
