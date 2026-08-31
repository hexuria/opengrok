import { join } from "node:path";

import { createAskpassService, type AskpassService } from "./askpass-service.js";

/**
 * Process-wide askpass service. Lazily started so tests and non-Electron
 * importers never touch the filesystem, and shared between the two consumers:
 * the coordinator's local-exec daemon spawn (which needs the env trio) and
 * the main edge (which answers prompts from the renderer card).
 */

export const ASKPASS_PROMPT_CHANNEL = "sand:askpass-prompt";

let service: AskpassService | null = null;
let resolveUserData: (() => string) | null = null;
let broadcast: ((channel: string, payload: unknown) => void) | null = null;

export function configureAskpassRuntime(options: {
  readonly userDataPath: () => string;
  readonly broadcast?: (channel: string, payload: unknown) => void;
}): void {
  resolveUserData = options.userDataPath;
  if (options.broadcast != null) broadcast = options.broadcast;
}

export function askpassService(): AskpassService | null {
  if (service != null) return service;
  if (process.platform === "win32" || resolveUserData == null) return null;
  try {
    const created = createAskpassService({ directory: join(resolveUserData(), "askpass") });
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
