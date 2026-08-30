import { displaySpaceSentence } from "../../box/box-monitor-layout.js";

export const COMPUTER_USE_SUBAGENT_TYPE = "computerUse";
const normalize = (value: string): string => value.replace(/[-_ ]/g, "").toLowerCase();
export const isComputerUseSubagentType = (value: string | null | undefined): boolean => value != null && normalize(value) === normalize(COMPUTER_USE_SUBAGENT_TYPE);

export function computerUseSubagentDescription(browserUseOffered: boolean): string {
  return [
    ...(browserUseOffered ? [
      "Delegate a self-contained desktop task to a background subagent that drives your box's desktop — GUI apps, file dialogs, drag interactions, and sites that defeat page-level automation — by screenshot, click, drag, type, key, scroll, and wait.",
      "For browser-only work, dispatch browserUse instead; use computerUse when the task needs the desktop itself or a browserUse dispatch reported a site it could not operate.",
    ] : [
      "Delegate a self-contained GUI / desktop task to a background subagent that drives your box's desktop — browsing, signing in to sites, and using GUI apps — by screenshot, click, drag, type, key, scroll, and wait.",
    ]),
    displaySpaceSentence(),
    "It runs in the background like any Task: you are notified when it finishes, so do not poll or await it.",
    "It runs headless and cannot ask follow-ups, so give it a tightly-scoped, self-contained task — the smallest concrete step rather than a sprawling goal — with the specifics it needs (site, account, exact values), explicit success criteria and stopping point, and what to report back; break a big GUI goal into several narrow dispatches, and if one runs long or loops, steer it with MessageSubagent or stop it with StopSubagent.",
    "Only one computerUse subagent can run at a time, because they share your desktop's single screen — never dispatch a second while one is still running.",
    "It cannot act as the user: if a step needs a human (entering a password, 2FA, a captcha, a payment) it stops and reports back, so you can hand the user the box with request_box_help and then dispatch it again to continue.",
  ].join(" ");
}

export const createSandComputerUseSubagentConfig = (args: { browserUseOffered: boolean }) => ({
  subagent_type: { type: { case: "custom", value: { name: COMPUTER_USE_SUBAGENT_TYPE } } },
  description: computerUseSubagentDescription(args.browserUseOffered),
  preserveTaskTool: false,
  subagentSource: "builtin" as const,
});
