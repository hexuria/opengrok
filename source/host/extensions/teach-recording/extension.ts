import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDebouncePolicy, realClock } from "../../../internal/scheduling.js";
import { SAND_TEACH_MAX_DURATION_MS } from "../../../shared/agents/teach-recording.js";
import { getSandRootDir } from "../../host-paths.js";
import type { HostBox } from "../forever-box/host-box.js";
import { createTeachRecordingService, LEARN_SKILL_NAME } from "./teach-recording-service.js";

export const CAP_SLACK_MS = 2_000;
export const TEACH_QUEUE_KEY_FILENAME = "teach-queue-key.json";
export function parseTeachQueueKey(raw: string): Buffer | null { try { const parsed = JSON.parse(raw) as { version?: unknown; keyHex?: unknown }; return parsed.version === 1 && typeof parsed.keyHex === "string" && /^[0-9a-f]{64}$/.test(parsed.keyHex) ? Buffer.from(parsed.keyHex, "hex") : null; } catch { return null; } }
export async function loadTeachQueueKey(sandRoot = getSandRootDir()): Promise<Buffer> { const path = join(sandRoot, TEACH_QUEUE_KEY_FILENAME); let raw: string | null = null; try { raw = await readFile(path, "utf8"); } catch {} const existing = raw == null ? null : parseTeachQueueKey(raw); if (existing != null) return existing; const key = randomBytes(32); await mkdir(sandRoot, { recursive: true }); await writeFile(path, JSON.stringify({ version: 1, keyHex: key.toString("hex") }), { mode: 0o600 }); return key; }

export interface TeachRecordingExtensionContext {
  deps: {
    experiments: { checkFeatureGate(name: string): boolean };
    "forever-box": { box: HostBox };
    "managed-setup": { ensureManagedSkill(id: string): Promise<boolean> };
    transcript: { sendPrompt(content: string, options: Record<string, unknown>): Promise<void>; listAgentIds(): Promise<readonly string[]> };
    telemetry: { analytics: { trackEvent(name: string, event: Record<string, unknown>): void }; logs: { reportTeachRecordingCapStopFailed(event: Record<string, unknown>): void; reportTeachRecordingStartFailed(event: Record<string, unknown>): void } };
  };
  onStop(fn: () => Promise<void>): void;
  host: { log(message: string): void };
}

export const teachRecordingExtension = {
  id: "teach-recording",
  dependencies: ["experiments", "forever-box", "managed-setup", "telemetry", "transcript"] as const,
  async start(context: TeachRecordingExtensionContext) {
    const analytics = context.deps.telemetry.analytics;
    const service = createTeachRecordingService({
      box: context.deps["forever-box"].box,
      isEnabled: () => context.deps.experiments.checkFeatureGate("sand_teach_by_demonstration"),
      capPolicy: createDebouncePolicy(realClock, { name: "teach-recording-cap", delayMs: SAND_TEACH_MAX_DURATION_MS + CAP_SLACK_MS }),
      sendLearningPrompt: (agentId, prompt) => context.deps.transcript.sendPrompt(prompt.content, { agentId, clientNonce: prompt.clientNonce, directAddressedAcceptance: true, awaitTurn: false, richText: prompt.richText }),
      listAgentIds: () => context.deps.transcript.listAgentIds(),
      queueSignatureKey: () => loadTeachQueueKey(),
      ensureLearningWorkflow: () => context.deps["managed-setup"].ensureManagedSkill(LEARN_SKILL_NAME),
      trackRecordingStarted: event => analytics.trackEvent("sand.teach.recording_started", event),
      trackRecordingStopped: event => analytics.trackEvent("sand.teach.recording_stopped", event),
      reportCapStopFailed: event => context.deps.telemetry.logs.reportTeachRecordingCapStopFailed(event),
      reportStartFailed: event => context.deps.telemetry.logs.reportTeachRecordingStartFailed(event)
    });
    try { await service.recoverPending(); } catch { context.host.log("teach-recording: pending delivery recovery failed"); }
    context.onStop(() => service.dispose());
    return service.api;
  }
};
