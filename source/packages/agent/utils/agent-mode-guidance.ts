const MODE_DISPLAY_NAMES = {
  agent: "Agent",
  plan: "Plan",
  debug: "Debug",
  chat: "Ask",
  multitask: "Multitask",
} as const;

function isUnifiedModeId(mode: string): mode is keyof typeof MODE_DISPLAY_NAMES {
  return Object.hasOwn(MODE_DISPLAY_NAMES, mode);
}

export function buildCurrentModeStatement(
  currentMode: string,
  _targetModes: unknown,
  _fromModes: unknown,
): string {
  const currentDisplayName = isUnifiedModeId(currentMode)
    ? MODE_DISPLAY_NAMES[currentMode]
    : currentMode;
  return `You are now in ${currentDisplayName} mode. You have EXITED your previous mode. Continue with the task in the new mode.`;
}
