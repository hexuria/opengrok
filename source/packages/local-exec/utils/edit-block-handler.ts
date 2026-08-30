import {
  ShellPermissionDenied,
  ShellRejected,
  type ShellResult,
} from "../../proto/generated/agent/v1/shell_exec_pb.js";
import { formatAdminCommandDenylistBlockReason } from "../services/admin-command-denylist.js";

export type ShellBlockReason =
  | { readonly type: "userRejected"; readonly reason: string }
  | { readonly type: "unsafeResolution"; readonly message: string }
  | { readonly type: "adminCommandDenylist"; readonly pattern: string }
  | {
      readonly type:
        | "needsApproval"
        | "cursorIgnore"
        | "adminBlock"
        | "permissionsConfig"
        | "cursorFiles";
      readonly isReadonly?: boolean;
    };

export function shellBlockReasonMessage(reason: ShellBlockReason): string {
  switch (reason.type) {
    case "userRejected":
      return reason.reason;
    case "unsafeResolution":
      return reason.message;
    case "adminCommandDenylist":
      return formatAdminCommandDenylistBlockReason(reason.pattern);
    case "needsApproval":
    case "cursorIgnore":
    case "adminBlock":
    case "permissionsConfig":
    case "cursorFiles":
      return "Command is not allowed";
    default: {
      const _exhaustive: never = reason;
      return `Command is not allowed (${JSON.stringify(_exhaustive)})`;
    }
  }
}

export function shellCommandBlockResult(
  command: string,
  workingDirectory: string,
  reason: ShellBlockReason,
): ShellResult["result"] {
  if (reason.type === "permissionsConfig" && (reason.isReadonly ?? false)) {
    return {
      case: "permissionDenied",
      value: new ShellPermissionDenied({
        command,
        workingDirectory,
        error: "Command blocked by permissions configuration",
        isReadonly: true,
      }),
    };
  }
  return {
    case: "rejected",
    value: new ShellRejected({
      command,
      workingDirectory,
      reason: shellBlockReasonMessage(reason),
    }),
  };
}
