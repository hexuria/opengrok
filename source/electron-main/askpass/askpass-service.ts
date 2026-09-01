import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

/**
 * The app-side half of the sudo askpass flow. `sudo -A` on the user's machine
 * runs our helper script; the helper connects to this unix socket with a
 * per-boot secret and the prompt sudo gave it; the app answers with the
 * user's password from an inline card, or closes to deny. The password exists
 * only in this hop — never in the transcript, the network, a log, or a file —
 * which is the whole reason this service lives in electron-main rather than
 * riding the box gateway: in remote-box mode that path leaves the machine.
 */

export interface AskpassPrompt {
  readonly id: string;
  readonly prompt: string;
  /** Why the card is up, when it isn't a plain agent sudo (e.g. enabling the feature). */
  readonly reason?: string;
}

export interface AskpassService {
  readonly helperPath: string;
  readonly socketPath: string;
  readonly secret: string;
  /** SAND_ASKPASS_* trio for the local-exec daemon's spawn environment. */
  environment(): Record<string, string>;
  onPrompt(listener: (prompt: AskpassPrompt) => void): () => void;
  /** Answer the active prompt. `null` denies. Returns false for a stale id. */
  resolvePrompt(id: string, password: string | null): boolean;
  /** The prompt currently awaiting an answer, for late-joining windows. */
  pendingPrompt(): AskpassPrompt | null;
  /**
   * Let exactly the next connection through even while the feature is off,
   * tagging its card with `reason`. Used by the enable flow, whose own
   * `sudo -k -A -v` must be answered before the setting flips on.
   */
  allowNextPromptForValidation(reason?: string): void;
  close(): void;
}

export const ASKPASS_PROMPT_TIMEOUT_MS = 120_000;
const REQUEST_BYTE_CAP = 8_192;

// The helper pair is regenerated on every service start so an app upgrade or
// relocation can never leave a script pointing at a stale binary.
const CLIENT_SOURCE = `"use strict";
const net = require("node:net");
const socketPath = process.env.CURSOR_ASKPASS_SOCKET;
const secret = process.env.CURSOR_ASKPASS_SECRET;
if (!socketPath || !secret) process.exit(1);
const connection = net.connect(socketPath);
let raw = "";
connection.on("connect", () => {
  connection.write(JSON.stringify({ secret, prompt: process.argv[2] || "" }) + "\\n");
});
connection.on("data", (chunk) => { raw += chunk.toString("utf8"); });
connection.on("error", () => process.exit(1));
connection.on("close", () => {
  try {
    const reply = JSON.parse(raw.split("\\n")[0] || "null");
    if (reply && reply.ok === true && typeof reply.password === "string") {
      process.stdout.write(reply.password + "\\n");
      process.exit(0);
    }
  } catch {}
  process.exit(1);
});
setTimeout(() => process.exit(1), ${ASKPASS_PROMPT_TIMEOUT_MS + 10_000});
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

interface PendingAsk {
  readonly id: string;
  readonly prompt: string;
  readonly reason?: string;
  readonly socket: Socket;
  timer: NodeJS.Timeout | null;
}

export function createAskpassService(options: {
  readonly directory: string;
  readonly execPath?: string;
  readonly timeoutMs?: number;
  /** Master switch. When it returns false, connections are denied with no card. */
  readonly isEnabled?: () => boolean;
}): AskpassService {
  const timeoutMs = options.timeoutMs ?? ASKPASS_PROMPT_TIMEOUT_MS;
  const isEnabled = options.isEnabled ?? (() => true);
  let validationAllowance: { reason?: string } | null = null;
  const execPath = options.execPath ?? process.execPath;
  const secret = randomBytes(32).toString("hex");
  const socketPath = join(options.directory, "askpass.sock");
  const clientPath = join(options.directory, "askpass-client.cjs");
  const helperPath = join(options.directory, "askpass.sh");

  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  chmodSync(options.directory, 0o700);
  writeFileSync(clientPath, CLIENT_SOURCE, { mode: 0o700 });
  writeFileSync(
    helperPath,
    `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(execPath)} ${shellQuote(clientPath)} "$@"\n`,
    { mode: 0o700 },
  );
  rmSync(socketPath, { force: true });

  const listeners = new Set<(prompt: AskpassPrompt) => void>();
  const queue: PendingAsk[] = [];
  let active: PendingAsk | null = null;
  let sequence = 0;

  const secretBuffer = Buffer.from(secret, "utf8");
  const secretMatches = (candidate: unknown): boolean => {
    if (typeof candidate !== "string") return false;
    const presented = Buffer.from(candidate, "utf8");
    return presented.length === secretBuffer.length && timingSafeEqual(presented, secretBuffer);
  };

  const finish = (ask: PendingAsk, password: string | null): void => {
    if (ask.timer != null) clearTimeout(ask.timer);
    ask.timer = null;
    try {
      if (password != null) ask.socket.end(`${JSON.stringify({ ok: true, password })}\n`);
      else ask.socket.end(`${JSON.stringify({ ok: false })}\n`);
    } catch {
      /* the helper hung up first; sudo already failed on its side */
    }
  };

  const advance = (): void => {
    if (active != null) return;
    const next = queue.shift();
    if (next == null) return;
    active = next;
    next.timer = setTimeout(() => {
      if (active?.id === next.id) {
        active = null;
        finish(next, null);
        advance();
      }
    }, timeoutMs);
    for (const listener of listeners) listener({ id: next.id, prompt: next.prompt, ...(next.reason == null ? {} : { reason: next.reason }) });
  };

  const server: Server = createServer((socket) => {
    let raw = "";
    let admitted = false;
    socket.on("error", () => { /* helper death is sudo's failure to report */ });
    socket.on("data", (chunk) => {
      if (admitted) return;
      raw += chunk.toString("utf8");
      if (raw.length > REQUEST_BYTE_CAP) { socket.destroy(); return; }
      const newline = raw.indexOf("\n");
      if (newline < 0) return;
      admitted = true;
      let request: { secret?: unknown; prompt?: unknown } | null = null;
      try { request = JSON.parse(raw.slice(0, newline)) as { secret?: unknown; prompt?: unknown }; } catch { request = null; }
      if (request == null || !secretMatches(request.secret)) { socket.destroy(); return; }
      // Off unless the master switch is on, or the enable flow armed a one-shot
      // pass for its own validation sudo. A denied connection makes sudo fail
      // exactly as it did before this feature existed — no card, no root.
      let reason: string | undefined;
      if (isEnabled()) {
        reason = undefined;
      } else if (validationAllowance != null) {
        reason = validationAllowance.reason;
        validationAllowance = null;
      } else {
        socket.destroy();
        return;
      }
      sequence += 1;
      const ask: PendingAsk = {
        id: `askpass-${sequence}`,
        prompt: typeof request.prompt === "string" && request.prompt.trim().length > 0 ? request.prompt.trim().slice(0, 200) : "Password:",
        ...(reason == null ? {} : { reason }),
        socket,
        timer: null,
      };
      socket.once("close", () => {
        // sudo gave up (Ctrl-C, its own timeout): withdraw the card.
        if (active?.id === ask.id) { active = null; advance(); }
        else {
          const index = queue.indexOf(ask);
          if (index >= 0) queue.splice(index, 1);
        }
      });
      queue.push(ask);
      advance();
    });
  });
  server.listen(socketPath, () => {
    try { chmodSync(socketPath, 0o600); } catch { /* darwin applies dir mode */ }
  });
  server.on("error", () => { /* a dead socket surfaces as sudo failing with the TTY message, same as before this feature */ });

  return {
    helperPath,
    socketPath,
    secret,
    environment: () => ({
      SAND_ASKPASS_HELPER: helperPath,
      SAND_ASKPASS_SOCKET: socketPath,
      SAND_ASKPASS_SECRET: secret,
    }),
    onPrompt: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolvePrompt: (id, password) => {
      if (active == null || active.id !== id) return false;
      const ask = active;
      active = null;
      finish(ask, password);
      advance();
      return true;
    },
    pendingPrompt: () => (active == null ? null : { id: active.id, prompt: active.prompt, ...(active.reason == null ? {} : { reason: active.reason }) }),
    allowNextPromptForValidation: (reason) => { validationAllowance = { ...(reason == null ? {} : { reason }) }; },
    close: () => {
      for (const ask of [active, ...queue]) if (ask != null) finish(ask, null);
      queue.length = 0;
      active = null;
      server.close();
      rmSync(socketPath, { force: true });
    },
  };
}
