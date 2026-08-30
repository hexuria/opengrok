import { GrokBotService } from "../../packages/proto/generated/aiserver/v1/grok_bot_connect.ported.js";
import { createSandCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.js";
import type { SandTranscriptGateName } from "../../shared/transcript-server-gates.js";
import { subscribeTranscriptMutations } from "../transcript-mutation-events.js";
import {
  installTranscriptServerBridge,
  resolveTranscriptGates,
  TranscriptServerBridge,
  type LocalTranscriptEntry,
  type TranscriptServerClient,
} from "./transcript-server-bridge.js";

export interface TranscriptServerAuth {
  getAccessToken(options: { backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string>;
}

export interface TranscriptServerExperiments {
  checkFeatureGate(name: SandTranscriptGateName): boolean;
}

export function installHostTranscriptServer(options: {
  auth: TranscriptServerAuth;
  experiments: TranscriptServerExperiments;
  createClient?: () => TranscriptServerClient;
}): () => void {
  let client: TranscriptServerClient | undefined;
  const bridge = new TranscriptServerBridge({
    gates: () => resolveTranscriptGates({
      checkGate: (name) => options.experiments.checkFeatureGate(name),
    }),
    client: () => {
      const gates = resolveTranscriptGates({
        checkGate: (name) => options.experiments.checkFeatureGate(name),
      });
      if (!gates.doubleWrite && !gates.serverTail && !gates.storeRead) {
        return undefined;
      }
      return client ??= options.createClient?.() ?? createSandCursorBackendClient(GrokBotService, {
        getAccessToken: options.auth.getAccessToken,
        getMachineId: options.auth.getMachineId,
      }) as unknown as TranscriptServerClient;
    },
  });
  installTranscriptServerBridge(bridge);
  const unsubscribe = subscribeTranscriptMutations((mutation) => {
    if (mutation.kind !== "entries-upserted") return;
    const agentId = mutation.agentId;
    const entries = mutation.entries;
    if (typeof agentId !== "string" || !Array.isArray(entries)) return;
    void bridge.commit(agentId, entries as LocalTranscriptEntry[]);
  });
  return () => {
    unsubscribe();
    installTranscriptServerBridge(undefined);
  };
}
