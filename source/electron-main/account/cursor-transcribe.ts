import { createDeadlinePolicy, realClock, type DeadlinePolicy } from "../../internal/scheduling.js";
import { AiService } from "../../packages/proto/generated/aiserver/v1/aiserver_connect.js";
import { TranscribeAudioRequest, type TranscribeAudioResponse } from "../../packages/proto/generated/aiserver/v1/aiserver_pb.js";
import { createSandCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.js";

const TRANSCRIBE_TIMEOUT_MS = 60_000;
const DEFAULT_TRANSCRIBE_LANGUAGE = "en-US";
const transcribeDeadline = createDeadlinePolicy(realClock, { name: "cursor-transcribe-audio", timeoutMs: TRANSCRIBE_TIMEOUT_MS });

export class SandTranscribeEmptyAudioError extends Error {
  constructor() { super("Cannot transcribe empty audio."); }
}

export interface TranscribeAudioClient {
  transcribeAudio(
    request: TranscribeAudioRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<Pick<TranscribeAudioResponse, "text" | "transcriptionTimeMs">>;
}

export interface SandTranscriptionOptions {
  readonly getCursorAccessToken: (options?: { readonly backendUrl?: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly onRequestId?: (requestId: string) => void;
  readonly clientForTesting?: TranscribeAudioClient;
  readonly createClient?: (credentials: Pick<SandTranscriptionOptions, "getCursorAccessToken" | "getMachineId" | "onRequestId">) => TranscribeAudioClient;
  readonly deadline?: DeadlinePolicy;
}

export class SandTranscriptionManager {
  private client?: TranscribeAudioClient;
  constructor(private readonly options: SandTranscriptionOptions) {}

  private getClient(): TranscribeAudioClient {
    if (this.options.clientForTesting != null) return this.options.clientForTesting;
    if (this.client == null) {
      this.client = this.options.createClient?.({
        getCursorAccessToken: this.options.getCursorAccessToken,
        getMachineId: this.options.getMachineId,
        ...(this.options.onRequestId == null ? {} : { onRequestId: this.options.onRequestId }),
      }) ?? createSandCursorBackendClient(AiService, {
        getAccessToken: this.options.getCursorAccessToken,
        getMachineId: this.options.getMachineId,
        onRequestId: this.options.onRequestId,
      } as Parameters<typeof createSandCursorBackendClient>[1]);
    }
    return this.client;
  }

  async transcribe(args: { readonly audio: Uint8Array; readonly mimeType: string; readonly language?: string }): Promise<{ text: string; transcriptionTimeMs: number }> {
    if (args.audio.length === 0) throw new SandTranscribeEmptyAudioError();
    const language = args.language != null && args.language.length > 0 ? args.language : DEFAULT_TRANSCRIBE_LANGUAGE;
    const response = await (this.options.deadline ?? transcribeDeadline).run((signal) =>
      this.getClient().transcribeAudio(new TranscribeAudioRequest({
        audio: new Uint8Array(args.audio),
        mimeType: (args.mimeType.split(";")[0] ?? args.mimeType).trim(),
        language,
      }), { signal }));
    return { text: response.text, transcriptionTimeMs: Number(response.transcriptionTimeMs) };
  }
}
