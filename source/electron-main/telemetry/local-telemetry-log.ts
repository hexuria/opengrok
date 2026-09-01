// A rolling JSONL mirror of the desktop's structured telemetry, on the user's own disk.
//
// Every transport event the coordinator already reports — stream connected / down with its
// generation and reason, reachability per gateway call, send stages, the SSE echo of a sent
// message, coordinator exits and relaunches, the renderer port handoff — flows through the
// structured-log uploader. Against an OpenGrok server that uploader lands in an endpoint that
// answers empty, so the evidence existed in memory and was thrown away; diagnosing "was the
// stream up when the user sent hello" meant guessing from process start times. This file is
// the durable copy: one line per event, timestamped, greppable, redacted.
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { getSandRootDir } from "../../host/host-paths.js";

export const LOCAL_TELEMETRY_LOG_FILENAME = "telemetry-log.jsonl";
export const LOCAL_TELEMETRY_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** Set to "0" to keep the desktop from writing the local log at all. */
export const LOCAL_TELEMETRY_LOG_ENV = "SAND_LOCAL_TELEMETRY_LOG";

const SECRET_KEY = /token|password|secret|authorization|cookie|vnc_?url|api_?key/i;
const SECRET_QUERY = /([?&](?:_token|password|token|key)=)[^&#\s"]+/gi;

export interface LocalTelemetryLog {
  readonly path: string;
  append(level: string, event: string, metadata: Readonly<Record<string, unknown>>): void;
  /** Resolves once every append issued so far has been written (or dropped). */
  settle(): Promise<void>;
}

/** Secret-bearing values never reach the disk: keys that name a secret are replaced, and a URL
 *  carrying `_token=` / `password=` keeps its shape without the value. */
export function redactTelemetryValue(key: string, value: unknown): unknown {
  if (SECRET_KEY.test(key)) return value == null ? value : "<redacted>";
  if (typeof value === "string") return value.replace(SECRET_QUERY, "$1<redacted>");
  return value;
}

export function redactTelemetryMetadata(metadata: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    out[key] = redactTelemetryValue(key, value);
  }
  return out;
}

export function localTelemetryLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LOCAL_TELEMETRY_LOG_ENV] !== "0";
}

export function createLocalTelemetryLog(options: {
  readonly dir: string;
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly filename?: string;
}): LocalTelemetryLog {
  const maxBytes = options.maxBytes ?? LOCAL_TELEMETRY_LOG_MAX_BYTES;
  const now = options.now ?? Date.now;
  const path = join(options.dir, options.filename ?? LOCAL_TELEMETRY_LOG_FILENAME);
  let chain: Promise<void> = Promise.resolve();
  let ready = false;
  const write = async (line: string): Promise<void> => {
    if (!ready) { await mkdir(options.dir, { recursive: true }); ready = true; }
    const size = await stat(path).then((s) => s.size).catch(() => 0);
    if (size + line.length > maxBytes) await rename(path, `${path}.1`).catch(() => { /* best effort */ });
    await appendFile(path, line);
  };
  return {
    path,
    append(level, event, metadata) {
      let line: string;
      try { line = `${JSON.stringify({ at: new Date(now()).toISOString(), level, event, ...redactTelemetryMetadata(metadata) })}\n`; }
      catch { return; }
      // Serialised so rolls and appends never interleave; a failed write never breaks the caller.
      chain = chain.then(() => write(line)).catch(() => { /* diagnostics never break the app */ });
    },
    settle() { return chain; },
  };
}

let shared: LocalTelemetryLog | null | undefined;

/** The process-wide log under the app's data dir, or `null` when `SAND_LOCAL_TELEMETRY_LOG=0`.
 *  Created on first use so a test process that never reports writes nothing. */
export function getLocalTelemetryLog(): LocalTelemetryLog | null {
  if (shared !== undefined) return shared;
  if (!localTelemetryLogEnabled()) { shared = null; return shared; }
  try { shared = createLocalTelemetryLog({ dir: getSandRootDir() }); }
  catch { shared = null; }
  return shared;
}

/** Tests only: forget the shared instance so the next call re-reads the environment. */
export function resetLocalTelemetryLogForTests(): void { shared = undefined; }
