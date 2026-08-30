export const BROWSER_USE_SUBAGENT_TYPE = "browserUse";
const normalize = (value: string): string => value.replace(/[-_ ]/g, "").toLowerCase();
export const isBrowserUseSubagentType = (value: string | null | undefined): boolean => value != null && normalize(value) === normalize(BROWSER_USE_SUBAGENT_TYPE);
export const BROWSER_USE_SUBAGENT_DESCRIPTION = [
  "Delegate a self-contained web task to a background subagent that drives your box's browser at the page level — navigating, reading structured page snapshots, clicking elements by reference, filling forms, and taking screenshots — without touching the desktop's mouse or keyboard.",
  "Prefer it over computerUse for browser-only work: page snapshots give it exact element targets, so it is faster and more reliable than pixel clicking, and it shares the box browser's persistent logins.",
  "Use computerUse instead when the task needs the desktop itself (GUI apps, file dialogs, drag interactions) or a site that defeats DOM automation.",
  "It runs in the background like any Task: you are notified when it finishes, so do not poll or await it.",
  "It runs headless and cannot ask follow-ups, so give it a tightly-scoped, self-contained task with the specifics it needs (site, exact values), explicit success criteria, and what to report back.",
  "It cannot act as the user: if a step needs a human (a password, 2FA, a captcha, a payment) it stops and reports back, so you can hand the user the box with request_box_help and dispatch it again to continue.",
].join(" ");
export const createSandBrowserUseSubagentConfig = () => ({
  subagent_type: { type: { case: "custom", value: { name: BROWSER_USE_SUBAGENT_TYPE } } },
  description: BROWSER_USE_SUBAGENT_DESCRIPTION,
  preserveTaskTool: false,
  subagentSource: "builtin" as const,
});
