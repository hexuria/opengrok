import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { COORDINATOR_CANCELLED, COORDINATOR_SERVER_READS_FAMILY, COORDINATOR_UNKNOWN_METHOD, type CoordinatorReplyOutcome } from "../../shared/rpc/coordinator-port.js";

// On the OpenGrok route the page keeps nothing: every roster and transcript it shows is a live
// read through this process. When the server cannot answer — a dead database, a restart, the LAN
// dropping — a read fails, the page is told nothing useful, and it paints the roster it has, which
// on a fresh launch or a refresh is nothing at all. On 2 Sep 2026 a twenty-minute database outage
// read to the person as "my bots have been deleted".
//
// This keeps the last good answer to the two reads that make up the picture, on disk, and serves
// it when the live read fails, while telling the page — on its own family, never the transport
// state that gates sends — that what it is showing is old. The page paints the last good state
// and a banner, instead of a blank.

/** The family the page listens on for "are reads live or stale". Distinct from the transport state on purpose. */
export const SERVER_READS_FAMILY = COORDINATOR_SERVER_READS_FAMILY;

export interface ServerReadsPayload {
  readonly state: "live" | "stale";
  /** When reads first started failing, epoch ms; null when live. */
  readonly since: number | null;
  /** Whether the page has something old to show, or nothing at all. */
  readonly cached: boolean;
  /** When the roster being shown was last read live, epoch ms; null when nothing is cached. */
  readonly cachedAt: number | null;
  readonly message: string | null;
}

interface Entry { readonly value: unknown; readonly at: number }
interface CacheFile { readonly schemaVersion: 1; readonly roster?: Entry; readonly tails: Record<string, Entry> }

/** How many coworkers' transcript tails to keep; the oldest fetched go first. */
export const MAX_CACHED_TAILS = 40;
/** A single answer bigger than this is not cached: it would make every save slow for one screen. */
export const MAX_ENTRY_BYTES = 2_000_000;
const SAVE_DEBOUNCE_MS = 500;
/** A single failed read is not an outage: reads race the transport at boot and a restart drops one. The page is told only when failures persist this long. */
export const STALE_GRACE_MS = 5_000;
/** How long a live read may take before the last good answer is served in its place, once a failure has been seen. The page gives up on a read well before the gateway's own timeout, so waiting for that timeout is the same as answering nothing. */
export const SERVE_CACHED_AFTER_MS = 2_000;
/** The same, while the server is believed healthy: long enough that a slow-but-working server is not shown one read behind, short of the gateway's 10 s pool timeout. */
export const SERVE_CACHED_WHEN_HEALTHY_MS = 8_000;
/** While reads are stale the roster is re-read this often, so the page hears "live" again without having asked for anything. */
export const REVALIDATE_WHILE_STALE_MS = 5_000;

export type ReadDispatch = (method: string, args: unknown, signal?: AbortSignal) => Promise<CoordinatorReplyOutcome>;

function keyFor(method: string, args: unknown): string | null {
  if (method === "listAgents") return "roster";
  if (method === "getAgentTranscriptTail" && typeof args === "object" && args != null) {
    const id = (args as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return `tail:${id}`;
  }
  return null;
}

/** The code the gateway client gives a read the server did not answer: connection refused, timed out, or a 5xx such as its database pool timing out. */
export const SERVER_DID_NOT_ANSWER = "gateway-unreachable";

/**
 * A failure that says the server did not answer, as opposed to a request that was wrong. A 4xx
 * for one coworker (deleted, not shared with this key) or a malformed reply is that request's
 * own problem: it goes back to the page as the failure it is and counts for nothing here.
 */
function serverCouldNotAnswer(outcome: CoordinatorReplyOutcome): outcome is { status: "failed"; failure: { code: string; message: string } } {
  if (outcome.status !== "failed") return false;
  const code = outcome.failure.code;
  if (code === COORDINATOR_UNKNOWN_METHOD || code === COORDINATOR_CANCELLED) return false;
  return code === SERVER_DID_NOT_ANSWER;
}

function isEntry(value: unknown): value is Entry {
  return typeof value === "object" && value != null && "value" in value && typeof (value as { at?: unknown }).at === "number";
}

/**
 * Whether a stream frame on the `agents` channel says the roster is complete and empty. The
 * server opens every events stream with such a frame built from a roster read it does not
 * check; with its database down that read fails, the frame says "no coworkers, stamped
 * current", and the page installs it over what it has. One that would erase a cached roster is
 * verified with a live read before it is let through.
 */
export function rosterFrameClaimsEmpty(payload: unknown): boolean {
  if (typeof payload !== "object" || payload == null) return false;
  const frame = payload as { agents?: unknown; coverage?: { kind?: unknown } };
  if (!Array.isArray(frame.agents) || frame.agents.length > 0) return false;
  const kind = frame.coverage?.kind;
  return kind == null || kind === "complete-roster";
}

export function loadCacheFile(path: string): CacheFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile>;
    if (parsed?.schemaVersion !== 1 || typeof parsed.tails !== "object" || parsed.tails == null) return { schemaVersion: 1, tails: {} };
    const tails = Object.fromEntries(Object.entries(parsed.tails).filter(([, entry]) => isEntry(entry)));
    return { schemaVersion: 1, ...(isEntry(parsed.roster) ? { roster: parsed.roster } : {}), tails };
  } catch {
    return { schemaVersion: 1, tails: {} };
  }
}

function persist(path: string, file: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  // Transcripts are in here: owner-only, like the rest of the data dir should be.
  writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
  renameSync(temp, path);
}

export function createCachedReadDispatch(options: {
  readonly dispatch: ReadDispatch;
  readonly cacheFile: string;
  readonly postEvent: (family: string, payload: ServerReadsPayload) => void;
  // The page keeps a saved roster and saved messages of its own and shows them, with "Retrying"
  // and sends parked, when the transport is down. With the event stream up and only the reads
  // failing (a dead database), it believes it is connected, has an epoch from the stream, and
  // refuses an unstamped roster — cached or saved — so it paints nothing. Reads that have failed
  // past the grace put the page into its offline mode; the first live read takes it out. Sends
  // parked meanwhile would have failed at the server anyway.
  readonly postTransportState: (state: "down" | "connected") => void;
  /**
   * Called once when reads come back, with the coworker whose tail was last read.
   *
   * `openAgentTail` marks a coworker active on the server as a side effect; a tail served from
   * the cache skips that, so after an outage the server's own idea of the active coworker is
   * whatever it was before — and every complete-roster frame it sends says so. Re-opening the
   * tail the person is actually looking at puts that right.
   */
  readonly onReadsRecovered?: (lastTailAgentId: string | null) => void;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Test seam: run the save now instead of after the debounce. */
  readonly saveImmediately?: boolean;
  /** Test seam: how long a live read may take before the cache answers instead, once a failure has been seen. */
  readonly serveCachedAfterMs?: number;
  /** Test seam: the same while the server is believed healthy. */
  readonly serveCachedWhenHealthyMs?: number;
  /** Test seam: how often the roster is re-read while stale. */
  readonly revalidateEveryMs?: number;
}): ReadDispatch & {
  readonly current: () => ServerReadsPayload;
  readonly flush: () => void;
  /** How many coworkers the cached roster holds; 0 when nothing is cached. */
  readonly cachedRosterCount: () => number;
  /** Reads the roster live, through the same bookkeeping as any read; the rows on success, null when the server could not answer. */
  readonly revalidateRoster: () => Promise<unknown[] | null>;
} {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const loaded = loadCacheFile(options.cacheFile);
  let roster: Entry | undefined = loaded.roster;
  const tails = new Map<string, Entry>(Object.entries(loaded.tails));
  // Reads are numbered as they start; an answer is remembered only if no later read of the same
  // key has been remembered already, so two reads in flight cannot leave the older one on disk.
  let readSeq = 0;
  const rememberedSeq = new Map<string, number>();
  let status: ServerReadsPayload = { state: "live", since: null, cached: false, cachedAt: null, message: null };
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // The first failure starts the clock; the page hears "stale" when a failure lands past the
  // grace, or the grace runs out with no success in between. A success cancels it.
  let firstFailureAt: number | null = null;
  /** The coworker whose transcript was read most recently, live or from the cache. */
  let lastTailAgentId: string | null = null;
  let lastFailure: { code: string; message: string } | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let revalidateTimer: ReturnType<typeof setTimeout> | null = null;
  const revalidateEveryMs = options.revalidateEveryMs ?? REVALIDATE_WHILE_STALE_MS;

  const save = (): void => {
    saveTimer = null;
    try {
      persist(options.cacheFile, { schemaVersion: 1, ...(roster == null ? {} : { roster }), tails: Object.fromEntries(tails) });
    } catch (error) {
      log(`read cache could not be saved: ${String(error)}`);
    }
  };
  const scheduleSave = (): void => {
    if (options.saveImmediately) { save(); return; }
    if (saveTimer != null) return;
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
    saveTimer.unref?.();
  };

  const remember = (key: string, value: unknown, seq: number): void => {
    if (seq < (rememberedSeq.get(key) ?? 0)) return;
    rememberedSeq.set(key, seq);
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { return; }
    if (bytes > MAX_ENTRY_BYTES) return;
    const entry = { value, at: now() };
    if (key === "roster") { roster = entry; scheduleSave(); return; }
    tails.set(key, entry);
    if (tails.size > MAX_CACHED_TAILS) {
      const oldest = [...tails.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) tails.delete(oldest[0]);
    }
    scheduleSave();
  };

  const recall = (key: string): Entry | undefined => (key === "roster" ? roster : tails.get(key));

  /** Posts the reads state when it changed; true when it did, so the transport follows it exactly once per transition. */
  const announce = (next: ServerReadsPayload): boolean => {
    const changed = next.state !== status.state;
    if (!changed && next.cached === status.cached) return false;
    status = next;
    options.postEvent(SERVER_READS_FAMILY, status);
    return changed;
  };
  const clearGrace = (): void => { if (graceTimer != null) { clearTimeout(graceTimer); graceTimer = null; } };
  const stopRevalidating = (): void => { if (revalidateTimer != null) { clearTimeout(revalidateTimer); revalidateTimer = null; } };
  // With nothing on screen asking, no read would ever run again and the page would stay on the
  // banner after the server came back. One roster read at a time, re-armed after each failure.
  const revalidateLater = (): void => {
    if (revalidateTimer != null) return;
    revalidateTimer = setTimeout(() => {
      revalidateTimer = null;
      void revalidateRoster().then((rows) => { if (rows == null && status.state === "stale") revalidateLater(); }).catch((error) => { log(`roster revalidation failed: ${String(error)}`); if (status.state === "stale") revalidateLater(); });
    }, revalidateEveryMs);
    revalidateTimer.unref?.();
  };
  const announceStale = (): void => {
    if (firstFailureAt == null || lastFailure == null) return;
    if (announce({ state: "stale", since: firstFailureAt, cached: roster != null, cachedAt: roster?.at ?? null, message: lastFailure.message })) {
      log(`reads are failing (${lastFailure.code}: ${lastFailure.message}); serving the last good answers`);
      options.postTransportState("down");
    }
    revalidateLater();
  };

  // The bookkeeping every live answer gets, whether the caller waited for it or was already
  // given the cache: remember it, and move the reads state.
  const settle = (key: string, seq: number, outcome: CoordinatorReplyOutcome): CoordinatorReplyOutcome => {
    if (outcome.status === "ok") {
      remember(key, outcome.value, seq);
      clearGrace();
      const wasFailing = firstFailureAt != null;
      firstFailureAt = null;
      lastFailure = null;
      if (status.state === "stale") {
        stopRevalidating();
        try { options.onReadsRecovered?.(lastTailAgentId); } catch (error) { log(`reads-recovered hook failed: ${String(error)}`); }
        log(`reads are live again after ${Math.round((now() - (status.since ?? now())) / 1000)}s`);
        if (announce({ state: "live", since: null, cached: false, cachedAt: null, message: null })) options.postTransportState("connected");
      } else if (wasFailing) {
        log("a read failed and the next one succeeded; the page was not told");
      }
      return outcome;
    }
    if (!serverCouldNotAnswer(outcome)) return outcome;
    const entry = recall(key);
    lastFailure = outcome.failure;
    if (firstFailureAt == null) {
      firstFailureAt = now();
      if (graceTimer == null) { graceTimer = setTimeout(() => { graceTimer = null; announceStale(); }, STALE_GRACE_MS); graceTimer.unref?.(); }
    } else if (now() - firstFailureAt >= STALE_GRACE_MS) {
      clearGrace();
      announceStale();
    }
    if (entry == null) return outcome;
    return { status: "ok", value: entry.value };
  };

  const revalidateRoster = async (): Promise<unknown[] | null> => {
    const seq = ++readSeq;
    let outcome: CoordinatorReplyOutcome;
    try {
      outcome = await options.dispatch("listAgents", {});
    } catch (error) {
      outcome = { status: "failed", failure: { code: SERVER_DID_NOT_ANSWER, message: String(error) } };
    }
    settle("roster", seq, outcome);
    return outcome.status === "ok" && Array.isArray(outcome.value) ? outcome.value : null;
  };

  const serveCachedAfterMs = options.serveCachedAfterMs ?? SERVE_CACHED_AFTER_MS;
  const serveCachedWhenHealthyMs = options.serveCachedWhenHealthyMs ?? SERVE_CACHED_WHEN_HEALTHY_MS;
  const dispatch: ReadDispatch = async (method, args, signal) => {
    const key = keyFor(method, args);
    if (key == null) return options.dispatch(method, args, signal);
    if (key.startsWith("tail:")) lastTailAgentId = key.slice("tail:".length);
    const entry = recall(key);
    const seq = ++readSeq;
    // The live read always runs and always settles, so the cache stays fresh and the state stays
    // true; what changes is whether the caller waits for it.
    const live = options.dispatch(method, args, signal).then((outcome) => settle(key, seq, outcome));
    if (entry == null) return live;
    if (status.state === "stale") {
      // Reads are known to be failing: answer from the cache at once and revalidate behind it.
      void live.catch(() => {});
      return { status: "ok", value: entry.value };
    }
    // Reads are believed live: give the server a moment, then answer from the cache rather than
    // let the page time out. The live read carries on and, if it succeeds, refreshes the cache
    // for the page's next read. The moment is short once a failure has been seen and long while
    // the server looks healthy, so a merely slow server is not shown one read behind.
    const waitMs = firstFailureAt != null ? serveCachedAfterMs : serveCachedWhenHealthyMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cachedSoon = new Promise<CoordinatorReplyOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ status: "ok", value: entry.value }), waitMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([live, cachedSoon]);
    } finally {
      if (timer != null) clearTimeout(timer);
      void live.catch(() => {});
    }
  };

  return Object.assign(dispatch, {
    current: () => status,
    flush: () => { if (saveTimer != null) { clearTimeout(saveTimer); save(); } },
    cachedRosterCount: () => (Array.isArray(roster?.value) ? roster.value.length : 0),
    revalidateRoster,
    /** Test seam: the grace has elapsed. */
    graceElapsed: () => { clearGrace(); announceStale(); },
  });
}
