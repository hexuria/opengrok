import { classifyMessagesAccess, type MessagesAccess } from "../../host/local-exec/messages-db.js";

/**
 * Full Disk Access is the one privacy category macOS never prompts for. Camera,
 * microphone, Contacts, Calendar, Automation and even the Desktop/Documents
 * folders all raise a consent dialog on first use; `kTCCServiceSystemPolicyAllFiles`
 * deliberately does not, and there is no API to request it. An app that touches
 * ~/Library/Messages without it simply gets EPERM, silently.
 *
 * So this cannot make the system prompt appear. What it does is notice the
 * refusal and put the right settings pane one click away, instead of leaving a
 * person to discover a manual-only grant on their own.
 */
export const FULL_DISK_ACCESS_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

export type FullDiskAccessOutcome = "granted" | "unsupported" | "already-asked" | "no-messages-db" | "opened-settings" | "relaunching" | "declined";

export interface FullDiskAccessCheckDependencies {
  readonly platform?: NodeJS.Platform;
  readonly probe?: () => MessagesAccess;
  readonly dialog: {
    showMessageBox(options: Record<string, unknown>): Promise<{ readonly response: number; readonly checkboxChecked?: boolean }>;
  };
  openExternal(url: string): Promise<unknown> | unknown;
  /** Whether the one-time ask has already been made. */
  hasAsked(): boolean;
  markAsked(): void;
  /** Restarts the app, and the helper, so a freshly granted permission takes effect. */
  relaunch?(): void | Promise<void>;
  reportFailure?(surface: string, operation: string, error: unknown): void;
}

export const FULL_DISK_ACCESS_MESSAGE = "Open Grok needs Full Disk Access to read Messages";
export const FULL_DISK_ACCESS_DETAIL =
  "macOS does not ask for this permission — it has to be granted by hand, once.\n\n"
  + "Open Settings takes you straight to the list. Add Open Grok, switch it on, then quit "
  + "and reopen the app.\n\n"
  + "Without it, reading your iMessages is the only thing that stops working.";

/**
 * Returns what happened rather than throwing: a permission nudge must never be
 * able to stop the app from starting.
 */
export async function runFullDiskAccessCheck(deps: FullDiskAccessCheckDependencies): Promise<FullDiskAccessOutcome> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return "unsupported";
  try {
    if (deps.hasAsked()) return "already-asked";
    const access = (deps.probe ?? (() => classifyMessagesAccess()))();
    if (access === "ok") return "granted";
    // A Mac that has never run Messages has nothing to read, so asking for the
    // permission would be noise.
    if (access === "missing") return "no-messages-db";

    const result = await deps.dialog.showMessageBox({
      type: "info",
      buttons: ["Open Settings", "Not Now"],
      defaultId: 0,
      cancelId: 1,
      message: FULL_DISK_ACCESS_MESSAGE,
      detail: FULL_DISK_ACCESS_DETAIL,
    });

    // Recorded before anything that could restart the app. Granting the
    // permission takes several steps in another application, so the next launch
    // will almost always still see it missing — asking again there would put
    // the app in a prompt-and-restart loop. One ask, then never again.
    deps.markAsked();
    if (result.response !== 0) return "declined";
    await deps.openExternal(FULL_DISK_ACCESS_PANE);

    // macOS decides a process's file access when it starts and caches it for
    // that process's lifetime, so granting the permission to a running app
    // changes nothing until it restarts — and the process that actually opens
    // the database is the helper, not this window. Offering the restart here is
    // the difference between the grant working and appearing to do nothing.
    if (deps.relaunch === undefined) return "opened-settings";
    const followUp = await deps.dialog.showMessageBox({
      type: "info",
      buttons: ["Quit & Reopen", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: "Quit and reopen to finish granting access",
      detail: "Add Open Grok to the list and switch it on first, then come back here.\n\n"
        + "macOS fixes a program's file access when it starts, so both this app and its "
        + "background helper have to be started fresh before the permission counts.",
    });
    if (followUp.response !== 0) return "opened-settings";
    await deps.relaunch();
    return "relaunching";
  } catch (error) {
    deps.reportFailure?.("startup", "full-disk-access", error);
    return "declined";
  }
}
