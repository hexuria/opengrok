import { join } from "node:path";

import { createAskpassService, type AskpassService } from "./askpass-service.js";
import { authorizeSudoEnable, createSudoValidator, type SudoEnableAuthResult } from "./sudo-enable-auth.js";

/**
 * Process-wide askpass service. Lazily started so tests and non-Electron
 * importers never touch the filesystem, and shared between the two consumers:
 * the coordinator's local-exec daemon spawn (which needs the env trio) and
 * the main edge (which answers prompts from the renderer card).
 */

export const ASKPASS_PROMPT_CHANNEL = "sand:askpass-prompt";

/** Native Touch ID surface, injected so electron's types stay out of source/. */
export interface AskpassBiometricPort {
  canPromptTouchID(): boolean;
  promptTouchID(reason: string): Promise<void>;
}

let service: AskpassService | null = null;
let resolveUserData: (() => string) | null = null;
let broadcast: ((channel: string, payload: unknown) => void) | null = null;
let readEnabled: (() => boolean) | null = null;
let biometric: AskpassBiometricPort | null = null;

export function configureAskpassRuntime(options: {
  readonly userDataPath: () => string;
  readonly broadcast?: (channel: string, payload: unknown) => void;
  readonly isEnabled?: () => boolean;
  readonly biometric?: AskpassBiometricPort | null;
}): void {
  resolveUserData = options.userDataPath;
  if (options.broadcast != null) broadcast = options.broadcast;
  if (options.isEnabled != null) readEnabled = options.isEnabled;
  if (options.biometric !== undefined) biometric = options.biometric;
}

export function askpassService(): AskpassService | null {
  if (service != null) return service;
  if (process.platform === "win32" || resolveUserData == null) return null;
  try {
    const created = createAskpassService({ directory: join(resolveUserData(), "askpass"), isEnabled: () => { try { return readEnabled?.() ?? false; } catch { return false; } } });
    // Each raised prompt is pushed to every open window; a window that mounts
    // after the prompt reads it back through the getAskpassPrompt edge.
    created.onPrompt((prompt) => broadcast?.(ASKPASS_PROMPT_CHANNEL, prompt));
    service = created;
  } catch {
    service = null;
  }
  return service;
}

/** SAND_ASKPASS_* env for the local-exec daemon; empty when unavailable. */
export function askpassDaemonEnvironment(): Record<string, string> {
  return askpassService()?.environment() ?? {};
}

export function closeAskpassRuntime(): void {
  service?.close();
  service = null;
}

/**
 * Production enable-auth: real Touch ID via Electron's systemPreferences, and
 * the password fallback validated through the live askpass service. Returns a
 * clean failure when there is no service (Windows, or unavailable).
 */
export async function authorizeSudoEnableProduction(): Promise<SudoEnableAuthResult> {
  const active = askpassService();
  if (active == null) return { ok: false, error: "Administrator commands are not available on this system." };
  const bio = biometric;
  return await authorizeSudoEnable({
    platform: process.platform,
    canPromptTouchID: () => { try { return bio?.canPromptTouchID() ?? false; } catch { return false; } },
    promptTouchID: (reason) => bio == null ? Promise.reject(new Error("no biometric")) : bio.promptTouchID(reason),
    runSudoValidate: createSudoValidator(active),
  });
}

/**
 * Which biometric the machine can actually prompt with, for labelling the
 * enable button. Null when there is no sensor, none enrolled, or the platform
 * has no supported biometric — the enable flow then uses the password card.
 */
export function askpassBiometricKind(): "touch-id" | "windows-hello" | null {
  if (process.platform === "darwin") {
    try { return biometric?.canPromptTouchID() === true ? "touch-id" : null; } catch { return null; }
  }
  return null;
}
