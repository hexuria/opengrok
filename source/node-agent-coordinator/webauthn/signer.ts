import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WebAuthnCeremony } from "../../shared/webauthn-gateway.js";

export const SIGNER_EVENT_PREFIX = "[signer-event] ";

export type SignerEvent =
  | { readonly kind: "presence-required" }
  | { readonly kind: "select-device" }
  | { readonly kind: "pin-not-set" }
  | { readonly kind: "pin-blocked" }
  | { readonly kind: "uv-blocked" }
  | { readonly kind: "uv-invalid" }
  | { readonly kind: "pin-required" }
  | { readonly kind: "pin-invalid"; readonly retries?: number };

export function describeSignerEventAsStatus(event: SignerEvent): string | undefined {
  switch (event.kind) {
    case "presence-required": return "Touch your security key now";
    case "select-device": return "Touch the security key you want to use";
    case "pin-not-set": return "This security key has no PIN set, but the site asked for one";
    case "pin-blocked": return "Your security key is locked";
    case "uv-blocked": return "Your security key's fingerprint check is locked";
    case "uv-invalid": return "That didn't match — try again on the key";
    case "pin-required":
    case "pin-invalid": return undefined;
  }
}

export interface WebAuthnSignerError {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
}

export type WebAuthnSignerResult =
  | { readonly ok: true; readonly credentialJson: unknown }
  | { readonly ok: false; readonly error: WebAuthnSignerError };

function failure(error: WebAuthnSignerError): WebAuthnSignerResult {
  return { ok: false, error };
}

export const SIGNER_BINARY = process.platform === "win32" ? "sand-webauthn-signer.exe" : "sand-webauthn-signer";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export function devRepoRoot(override?: string): string {
  if (override !== undefined) return override;
  return join(moduleDirectory, "..", "..", "..");
}

export function resolveWebAuthnSignerPath(options: { readonly isPackaged: boolean; readonly repoRoot?: string }): string | undefined {
  const override = process.env.SAND_WEBAUTHN_SIGNER_PATH;
  if (override !== undefined && override.length > 0) return existsSync(override) ? override : undefined;
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath ?? "";
  const candidates = options.isPackaged
    ? [join(resourcesPath, "app.asar.unpacked", "dist", "native", SIGNER_BINARY)]
    : [
        join(devRepoRoot(options.repoRoot), "target", "release", SIGNER_BINARY),
        join(devRepoRoot(options.repoRoot), "target", "debug", SIGNER_BINARY)
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function parseSignerEvent(body: string, log: (message: string) => void): SignerEvent | undefined {
  try {
    return JSON.parse(body) as SignerEvent;
  } catch (error) {
    log(`unreadable signer event ${body}: ${String(error)}`);
    return undefined;
  }
}

export interface ApprovedWebAuthnConsent {
  readonly approved: true;
  readonly promptId?: string;
  readonly windowHandle?: string;
}

export interface SpawnedWebAuthnSignerOptions {
  readonly binaryPath: string;
  readonly log?: (message: string) => void;
  readonly onStatus?: (status: string) => void;
  readonly onPinRequest?: (request: { readonly invalid: boolean; readonly retries?: number }, promptId: string) => Promise<string | undefined>;
}

export interface WebAuthnSigner {
  sign(ceremony: WebAuthnCeremony, signal: AbortSignal, approved?: ApprovedWebAuthnConsent): Promise<WebAuthnSignerResult>;
}

export function createSpawnedWebAuthnSigner(options: SpawnedWebAuthnSignerOptions): WebAuthnSigner {
  const log = options.log ?? (() => {});
  return {
    sign(ceremony, signal, approved) {
      return new Promise((resolve) => {
        const child = spawn(options.binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const settle = (result: WebAuthnSignerResult) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        };
        function onAbort() {
          child.kill("SIGTERM");
          settle(failure({ name: "NotAllowedError", code: "cancelled_or_timeout", message: "the security key request was cancelled" }));
        }
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdin.on("error", (error) => log(`signer stdin: ${error.message}`));
        const send = (reply: { readonly kind: "cancel" } | { readonly kind: "pin"; readonly pin: string }) => {
          if (settled || child.stdin.destroyed) return;
          child.stdin.write(`${JSON.stringify(reply)}\n`);
        };
        let promptsInOrder = Promise.resolve();
        const promptId = approved?.promptId;
        const answerPin = (request: { readonly invalid: boolean; readonly retries?: number }) => {
          promptsInOrder = promptsInOrder.then(async () => {
            const pin = promptId === undefined ? undefined : await options.onPinRequest?.(request, promptId);
            send(pin === undefined || pin === "" ? { kind: "cancel" } : { kind: "pin", pin });
          }).catch((error: unknown) => {
            log(`pin prompt failed: ${String(error)}`);
            send({ kind: "cancel" });
          });
        };
        const handleEvent = (event: SignerEvent) => {
          if (event.kind === "pin-required") return answerPin({ invalid: false });
          if (event.kind === "pin-invalid") {
            answerPin({ invalid: true, ...(event.retries == null ? {} : { retries: event.retries }) });
            return;
          }
          const status = describeSignerEventAsStatus(event);
          if (status !== undefined) options.onStatus?.(status);
        };
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        let pendingLine = "";
        child.stderr.on("data", (chunk) => {
          const text = String(chunk);
          stderr += text;
          pendingLine += text;
          let newline = pendingLine.indexOf("\n");
          while (newline >= 0) {
            const line = pendingLine.slice(0, newline).trim();
            pendingLine = pendingLine.slice(newline + 1);
            newline = pendingLine.indexOf("\n");
            if (!line.startsWith(SIGNER_EVENT_PREFIX)) continue;
            const event = parseSignerEvent(line.slice(SIGNER_EVENT_PREFIX.length), log);
            if (event !== undefined) handleEvent(event);
          }
        });
        child.on("error", (error) => {
          settle(failure({ name: "NotAllowedError", code: "helper_spawn_failed", message: `could not start the security key helper: ${error.message}` }));
        });
        child.on("close", (code) => {
          if (stderr.length > 0) log(`signer stderr: ${stderr.trim()}`);
          if (stdout.length === 0) {
            settle(failure({ name: "NotAllowedError", code: "helper_no_result", message: `the security key helper exited with code ${code} and no result` }));
            return;
          }
          try {
            settle(JSON.parse(stdout) as WebAuthnSignerResult);
          } catch (error) {
            settle(failure({ name: "NotAllowedError", code: "helper_no_result", message: `unreadable result from the security key helper: ${String(error)}` }));
          }
        });
        const windowHandle = approved?.windowHandle;
        child.stdin.write(`${JSON.stringify(windowHandle === undefined ? ceremony : { ...ceremony, windowHandle })}\n`);
      });
    }
  };
}
