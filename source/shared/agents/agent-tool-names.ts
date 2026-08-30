export const SAND_BOX_SHELL_TOOL_NAME = "Shell";
export const SAND_BOX_READ_TOOL_NAME = "Read";
export const SAND_BOX_AWAIT_SHELL_TOOL_NAME = "AwaitShell";
export const SAND_EXTERNAL_SHELL_TOOL_NAME = "ExternalShell";
export const SAND_EXTERNAL_READ_TOOL_NAME = "ExternalRead";
export const SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME = "AwaitExternalShell";
export const SAND_DEFAULT_EXTERNAL_MACHINE_ID = "user-computer";

export interface SandExternalMachine {
  readonly id: string;
  readonly label: string;
}

export const SAND_USER_COMPUTER: SandExternalMachine = {
  id: "user-computer",
  label: "the user's computer",
};

export const SAND_EXTERNAL_MACHINES: Readonly<Record<string, SandExternalMachine>> = {
  "user-computer": SAND_USER_COMPUTER,
};

export function resolveSandExternalMachine(
  id = SAND_DEFAULT_EXTERNAL_MACHINE_ID,
): SandExternalMachine | undefined {
  return SAND_EXTERNAL_MACHINES[id];
}

export type SandDualSurfaceToolTelemetry = {
  readonly toolName: string;
  readonly surface: "box" | "external";
};

export function sandDualSurfaceToolTelemetry(
  toolName: string,
): SandDualSurfaceToolTelemetry | undefined {
  switch (toolName) {
    case SAND_BOX_SHELL_TOOL_NAME:
    case SAND_BOX_READ_TOOL_NAME:
    case SAND_BOX_AWAIT_SHELL_TOOL_NAME:
      return { toolName, surface: "box" };
    case SAND_EXTERNAL_SHELL_TOOL_NAME:
    case SAND_EXTERNAL_READ_TOOL_NAME:
    case SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME:
      return { toolName, surface: "external" };
    default:
      return undefined;
  }
}
