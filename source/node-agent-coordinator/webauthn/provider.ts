import { SseBlockDecoder } from "../gateway/sse-block-decoder.js";
import {
  GATEWAY_WEBAUTHN_REQUESTS_PATH,
  GATEWAY_WEBAUTHN_RESPONSES_PATH,
  type WebAuthnCeremony,
  type WebAuthnRequestFrame,
  type WebAuthnResponseFrame
} from "../../shared/webauthn-gateway.js";
import type { ApprovedWebAuthnConsent, WebAuthnSigner } from "./signer.js";

export class WebAuthnChannelError extends Error {
  override readonly name = "WebAuthnChannelError";
}

export interface WebAuthnConnection {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly token?: string;
}

export interface RetryPolicy {
  runWithRetry<T>(work: (attempt: number, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface HeartbeatPolicy {
  start(work: () => Promise<void>, signal: AbortSignal): { dispose(): void };
}

export interface WebAuthnConsentProvider {
  requestConsent(ceremony: WebAuthnCeremony, signal: AbortSignal): Promise<ApprovedWebAuthnConsent | { readonly approved: false }>;
  finish(): void;
}

export interface WebAuthnProviderOptions {
  readonly resolveConnection: () => Promise<WebAuthnConnection>;
  readonly signer: WebAuthnSigner;
  readonly heartbeatPolicy: HeartbeatPolicy;
  readonly reconnectPolicy: RetryPolicy;
  readonly deliveryPolicy?: RetryPolicy;
  readonly consent?: WebAuthnConsentProvider;
  readonly computerId?: string;
  readonly label?: string;
  readonly log?: (message: string) => void;
}

export function createWebAuthnProvider(options: WebAuthnProviderOptions): { start(): void; stop(): void } {
  const log = options.log ?? (() => {});
  let lifetime: AbortController | undefined;
  let providerId: string | undefined;
  const inFlight = new Map<string, AbortController>();

  function headersFor(connection: WebAuthnConnection): Record<string, string> {
    return { ...(connection.headers ?? {}), ...(connection.token === undefined ? {} : { authorization: `Bearer ${connection.token}` }) };
  }

  async function postFrames(connection: WebAuthnConnection, frames: readonly WebAuthnResponseFrame[], signal?: AbortSignal): Promise<void> {
    const batch = providerId === undefined ? { frames } : { providerId, frames };
    const response = await fetch(`${connection.baseUrl}${GATEWAY_WEBAUTHN_RESPONSES_PATH}`, {
      method: "POST",
      headers: { ...headersFor(connection), "content-type": "application/json" },
      body: JSON.stringify(batch),
      ...(signal === undefined ? {} : { signal })
    });
    if (!response.ok) throw new WebAuthnChannelError(`webauthn response POST rejected: HTTP ${response.status}`);
  }

  async function runCeremony(connection: WebAuthnConnection, requestId: string, ceremony: WebAuthnCeremony): Promise<void> {
    const attempt = new AbortController();
    inFlight.set(requestId, attempt);
    log(`ceremony ${requestId}: ${ceremony.kind} for ${ceremony.origin}`);
    let failedStageIfThrown: Pick<Extract<WebAuthnResponseFrame, { kind: "stage" }>, "stage" | "outcome"> =
      options.consent === undefined ? { stage: "sign", outcome: "failed" } : { stage: "grant", outcome: "failed" };
    let frames: WebAuthnResponseFrame[];
    try {
      const consent = await options.consent?.requestConsent(ceremony, attempt.signal);
      if (consent !== undefined && !consent.approved) {
        await postFrames(connection, [
          { kind: "stage", requestId, stage: "grant", outcome: "declined" },
          { kind: "error", requestId, name: "NotAllowedError", message: "The security key request was declined on your computer." }
        ]);
        inFlight.delete(requestId);
        return;
      }
      if (consent !== undefined) {
        failedStageIfThrown = { stage: "sign", outcome: "failed" };
        await postFrames(connection, [{ kind: "stage", requestId, stage: "grant", outcome: "ok" }], attempt.signal)
          .catch((error: unknown) => log(`grant stage frame failed: ${String(error)}`));
      }
      if (attempt.signal.aborted) return;
      const result = await options.signer.sign(ceremony, attempt.signal, consent);
      frames = result.ok
        ? [
            { kind: "stage", requestId, stage: "sign", outcome: "ok" },
            { kind: "result", requestId, credentialJson: result.credentialJson }
          ]
        : [
            { kind: "stage", requestId, stage: "sign", outcome: "failed" },
            { kind: "error", requestId, name: result.error.name, message: result.error.message, ...(result.error.code === undefined ? {} : { code: result.error.code }) }
          ];
    } catch (error) {
      frames = [
        { kind: "stage", requestId, ...failedStageIfThrown },
        { kind: "error", requestId, name: "NotAllowedError", message: `the security key could not complete the request: ${error instanceof Error ? error.message : String(error)}` }
      ];
    } finally {
      options.consent?.finish();
      inFlight.delete(requestId);
    }
    if (attempt.signal.aborted) return;
    try {
      if (options.deliveryPolicy === undefined) await postFrames(connection, frames);
      else await options.deliveryPolicy.runWithRetry(() => postFrames(connection, frames), attempt.signal);
    } catch (error) {
      log(`ceremony ${requestId} result could not be delivered: ${String(error)}`);
    }
  }

  function handleFrame(connection: WebAuthnConnection, frame: WebAuthnRequestFrame): void {
    switch (frame.kind) {
      case "welcome":
        providerId = frame.providerId;
        void postFrames(connection, [{ kind: "hello", ...(options.computerId === undefined ? {} : { computerId: options.computerId }), ...(options.label === undefined ? {} : { label: options.label }) }])
          .catch((error: unknown) => log(`hello frame failed: ${String(error)}`));
        break;
      case "ceremony":
        void runCeremony(connection, frame.requestId, frame.ceremony);
        break;
      case "cancel":
        inFlight.get(frame.requestId)?.abort();
        inFlight.delete(frame.requestId);
        break;
    }
  }

  async function connectOnce(signal: AbortSignal): Promise<never> {
    const connection = await options.resolveConnection();
    const response = await fetch(`${connection.baseUrl}${GATEWAY_WEBAUTHN_REQUESTS_PATH}`, { headers: headersFor(connection), signal });
    if (!response.ok || response.body == null) throw new WebAuthnChannelError(`webauthn request stream refused: HTTP ${response.status}`);
    log("webauthn request stream open");
    providerId = undefined;
    const decoder = new SseBlockDecoder((block) => {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          handleFrame(connection, JSON.parse(line.slice("data:".length).trim()) as WebAuthnRequestFrame);
        } catch (error) {
          log(`dropped an unparseable request frame: ${String(error)}`);
        }
      }
    });
    const heartbeat = options.heartbeatPolicy.start(async () => {
      try { await postFrames(connection, [{ kind: "ping" }]); }
      catch (error) { log(`heartbeat failed: ${String(error)}`); }
    }, signal);
    try {
      for await (const chunk of response.body) decoder.push(chunk);
    } finally {
      heartbeat.dispose();
      for (const attempt of inFlight.values()) attempt.abort();
      inFlight.clear();
    }
    throw new WebAuthnChannelError("webauthn request stream closed");
  }

  return {
    start() {
      if (lifetime !== undefined) return;
      const controller = new AbortController();
      lifetime = controller;
      void options.reconnectPolicy.runWithRetry(async (_attempt, signal) => connectOnce(signal), controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) log(`webauthn provider gave up: ${String(error)}`);
      });
    },
    stop() {
      lifetime?.abort();
      lifetime = undefined;
    }
  };
}

