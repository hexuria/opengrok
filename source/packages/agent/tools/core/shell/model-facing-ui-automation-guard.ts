export const MODEL_FACING_SHELL_UI_AUTOMATION_BLOCK_REASON = "Direct UI automation through Shell is blocked. Use the Computer tool for pixel-level actions on the desktop.";
const UI_AUTOMATION_TOOL_PATTERN = /\b(xdotool|wmctrl|xte|ydotool|osascript|cliclick|pyautogui|pynput|robotjs|sikuli)\b|Quartz\.CGEvent|ApplicationServices\.framework/i;
const BROWSER_REMOTE_DEBUG_PATTERN = /--remote-debugging-port\b|--remote-debugging-pipe\b|chrome-devtools-protocol|puppeteer|playwright(?:@[^\s]+)?\s+(?:codegen|open)\b|chromedriver\b|selenium-server\b/i;
const INTERNAL_HOST_SCREENSHOT_PATTERN = /control-sand(?:\.mjs)?\b[^\n]*\bscreenshot\b/i;
export function isInternalHostScreenshotShellCommand(command: string): boolean { return INTERNAL_HOST_SCREENSHOT_PATTERN.test(command); }
export function checkModelFacingShellUiAutomation(command: string): { allow: true } | { allow: false; reason: string } {
  if (UI_AUTOMATION_TOOL_PATTERN.test(command) || BROWSER_REMOTE_DEBUG_PATTERN.test(command)) return { allow: false, reason: MODEL_FACING_SHELL_UI_AUTOMATION_BLOCK_REASON };
  if (isInternalHostScreenshotShellCommand(command)) return { allow: true };
  return { allow: true };
}
