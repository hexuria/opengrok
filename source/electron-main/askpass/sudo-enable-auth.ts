import { spawn } from "node:child_process";
import { homedir } from "node:os";

import type { AskpassService } from "./askpass-service.js";

/**
 * The gate on turning the sudo card ON. Proof the real user is present:
 * Touch ID when the Mac can, otherwise a one-shot `sudo -k -A -v` whose
 * password the user types into the card — which also proves they know it.
 * Turning the feature OFF never comes through here.
 */

export interface SudoEnableAuthResult {
  readonly ok: boolean;
  readonly method?: "touch-id" | "password";
  readonly error?: string;
}

export interface SudoEnableAuthDeps {
  readonly platform: NodeJS.Platform;
  readonly canPromptTouchID: () => boolean;
  readonly promptTouchID: (reason: string) => Promise<void>;
  /** Runs `sudo -k -A -v` against the askpass service; resolves the exit code. */
  readonly runSudoValidate: () => Promise<number>;
}

const ENABLE_REASON = "Enable administrator (sudo) commands";

export async function authorizeSudoEnable(deps: SudoEnableAuthDeps): Promise<SudoEnableAuthResult> {
  // Touch ID proves presence with no typing. It needs the app focused and a
  // fingerprint enrolled; canPromptTouchID gates that. Any failure or absence
  // falls through to the password, so there is always a working path.
  if (deps.platform === "darwin") {
    let biometricAvailable = false;
    try { biometricAvailable = deps.canPromptTouchID(); } catch { biometricAvailable = false; }
    if (biometricAvailable) {
      try {
        await deps.promptTouchID(ENABLE_REASON);
        return { ok: true, method: "touch-id" };
      } catch {
        // fall through to the password card
      }
    }
  }
  try {
    const code = await deps.runSudoValidate();
    if (code === 0) return { ok: true, method: "password" };
    return { ok: false, error: "That password was not accepted, so administrator commands stay off." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not verify your password." };
  }
}

/** Production `runSudoValidate`: real `sudo -k -A -v` through the live service. */
export function createSudoValidator(service: AskpassService): () => Promise<number> {
  return () => new Promise<number>((resolve) => {
    service.allowNextPromptForValidation(ENABLE_REASON);
    let settled = false;
    const done = (code: number) => { if (!settled) { settled = true; resolve(code); } };
    try {
      const child = spawn("sudo", ["-k", "-A", "-v"], {
        env: { ...process.env, ...service.environment() },
        cwd: homedir(),
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => done(1));
      child.once("exit", (code) => done(code == null ? 1 : code));
    } catch {
      done(1);
    }
  });
}
