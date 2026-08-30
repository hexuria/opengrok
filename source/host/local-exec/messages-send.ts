import { spawn } from "node:child_process";

/**
 * Sending runs through Messages.app over AppleScript, which macOS gates behind
 * Automation consent separately from the Full Disk Access that reading needs —
 * a Mac can be granted one and refuse the other.
 *
 * The recipient and the body are passed as `argv`, never interpolated into the
 * script. Both come from model output, and AppleScript string escaping is not
 * something to hand-roll around arbitrary text.
 */
export const SEND_IMESSAGE_APPLESCRIPT = `
on run argv
  set targetId to item 1 of argv
  set messageBody to item 2 of argv
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant targetId of targetService
    send messageBody to targetBuddy
  end tell
end run
`.trim();

export const MESSAGES_AUTOMATION_HINT =
  "macOS did not allow OpenGrok to control Messages. Grant it in System Settings › "
  + "Privacy & Security › Automation, enable Messages under OpenGrok, then try again. "
  + "Reinstalling OpenGrok revokes the grant, because it is tied to the app's code signature.";

export const MESSAGE_BODY_MAX = 4_000;

export type SendMessagesFailure = "not-authorized" | "unknown-recipient" | "messages-unavailable" | "failed";

/**
 * osascript reports everything as a non-zero exit with prose on stderr, so the
 * failure has to be read out of the text. The three cases are told apart
 * because they need different advice: a consent prompt, a corrected recipient,
 * or Messages not being set up at all.
 */
export function classifySendFailure(stderr: string): SendMessagesFailure {
  const text = stderr.toLowerCase();
  if (text.includes("not authorized") || text.includes("not allowed") || text.includes("-1743")) return "not-authorized";
  if (text.includes("can't get participant") || text.includes("invalid participant") || text.includes("-1728")) return "unknown-recipient";
  if (text.includes("can't get account") || text.includes("application isn't running")) return "messages-unavailable";
  return "failed";
}

export function sendFailureMessage(failure: SendMessagesFailure, recipient: string, stderr: string): string {
  if (failure === "not-authorized") return MESSAGES_AUTOMATION_HINT;
  if (failure === "unknown-recipient") {
    return `Messages could not resolve "${recipient}". Use the exact phone number in +country format `
      + "(e.g. +15551234567) or the Apple ID email the person uses for iMessage.";
  }
  if (failure === "messages-unavailable") {
    return "Messages has no iMessage account signed in on this Mac, so there is nothing to send from.";
  }
  return `Messages refused the send: ${stderr.trim().slice(0, 400)}`;
}

export interface SendIMessageResult {
  readonly sent: boolean;
  readonly error?: string;
}

export async function sendIMessage(
  args: { readonly to: string; readonly body: string },
  runner: (command: string, argv: readonly string[]) => Promise<{ readonly code: number; readonly stderr: string }> = runOsascript,
): Promise<SendIMessageResult> {
  const to = args.to.trim();
  const body = args.body.trim();
  if (to.length === 0) return { sent: false, error: "No recipient was given." };
  if (body.length === 0) return { sent: false, error: "The message body was empty, so nothing was sent." };
  if (body.length > MESSAGE_BODY_MAX) {
    return { sent: false, error: `The message body is ${body.length} characters; keep it under ${MESSAGE_BODY_MAX}.` };
  }
  const result = await runner("/usr/bin/osascript", ["-e", SEND_IMESSAGE_APPLESCRIPT, to, body]);
  if (result.code === 0) return { sent: true };
  return { sent: false, error: sendFailureMessage(classifySendFailure(result.stderr), to, result.stderr) };
}

export const SEND_TIMEOUT_MS = 20_000;

function runOsascript(command: string, argv: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...argv], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += "\nosascript timed out";
    }, SEND_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 8_192) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: 1, stderr: `${stderr}\n${error.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stderr }); });
  });
}
