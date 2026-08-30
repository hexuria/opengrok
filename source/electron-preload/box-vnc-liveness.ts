import {
  VNC_LIVENESS_MIN_IMPACTFUL_INPUTS,
  VNC_LIVENESS_WINDOW_MS,
  type VncLivenessReport,
} from "../shared/vnc-liveness.js";

export const BEACON_GLOBAL = "__sandVncLivenessBeacon";

export interface VncLivenessBeaconCounters {
  readonly keys: number;
  readonly clicks: number;
  readonly moves: number;
  readonly drawOps: number;
  readonly inBytes: number;
}

export function buildVncLivenessBeaconScript(): string {
  return `
    (function () {
      if (window.${BEACON_GLOBAL}) return;
      var counters = { keys: 0, clicks: 0, moves: 0, drawOps: 0, inBytes: 0 };
      window.${BEACON_GLOBAL} = counters;
      var PRIMARY_BUTTON_MASK_BITS = 0x07;
      var lastButtonMask = 0;
      import("./core/rfb.js").then(function (m) {
        var messages = m.default.messages;
        var keyEvent = messages.keyEvent;
        messages.keyEvent = function (sock, keysym, down) {
          if (down) counters.keys += 1;
          return keyEvent.apply(this, arguments);
        };
        if (typeof messages.QEMUExtendedKeyEvent === "function") {
          var qemuKeyEvent = messages.QEMUExtendedKeyEvent;
          messages.QEMUExtendedKeyEvent = function (sock, keysym, down) {
            if (down) counters.keys += 1;
            return qemuKeyEvent.apply(this, arguments);
          };
        }
        var pointerEvent = messages.pointerEvent;
        messages.pointerEvent = function (sock, x, y, mask) {
          if (mask & ~lastButtonMask & PRIMARY_BUTTON_MASK_BITS) counters.clicks += 1;
          else counters.moves += 1;
          lastButtonMask = mask;
          return pointerEvent.apply(this, arguments);
        };
      }).catch(function () {});
      import("./core/display.js").then(function (m) {
        var damage = m.default.prototype._damage;
        m.default.prototype._damage = function () {
          counters.drawOps += 1;
          return damage.apply(this, arguments);
        };
      }).catch(function () {});
      import("./core/websock.js").then(function (m) {
        var recvMessage = m.default.prototype._recvMessage;
        m.default.prototype._recvMessage = function (e) {
          counters.inBytes += (e && e.data && e.data.byteLength) || 0;
          return recvMessage.apply(this, arguments);
        };
      }).catch(function () {});
    })();
  `;
}

export function buildVncLivenessBeaconReadExpression(): string {
  return `JSON.stringify(window.${BEACON_GLOBAL} || null)`;
}

function isBeaconCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseVncLivenessBeaconCounters(raw: unknown): VncLivenessBeaconCounters | null {
  if (typeof raw !== "string") return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const counters = parsed as Record<string, unknown>;
  if (!isBeaconCount(counters.keys)
    || !isBeaconCount(counters.clicks)
    || !isBeaconCount(counters.moves)
    || !isBeaconCount(counters.drawOps)
    || !isBeaconCount(counters.inBytes)) return null;
  return {
    keys: counters.keys,
    clicks: counters.clicks,
    moves: counters.moves,
    drawOps: counters.drawOps,
    inBytes: counters.inBytes,
  };
}

interface VncLivenessDelta extends VncLivenessBeaconCounters { readonly atMs: number }

export function createVncLivenessDetector(): {
  sample(nowMs: number, counters: VncLivenessBeaconCounters): VncLivenessReport | null;
  reset(): void;
} {
  let last: VncLivenessBeaconCounters | null = null;
  let samples: VncLivenessDelta[] = [];
  let coveredSinceMs: number | null = null;
  let episodeFired = false;
  function reset(): void {
    last = null;
    samples = [];
    coveredSinceMs = null;
    episodeFired = false;
  }
  function rebaseline(nowMs: number, counters: VncLivenessBeaconCounters): void {
    reset();
    last = counters;
    coveredSinceMs = nowMs;
  }
  function sample(nowMs: number, counters: VncLivenessBeaconCounters): VncLivenessReport | null {
    if (last == null) {
      rebaseline(nowMs, counters);
      return null;
    }
    const delta: VncLivenessDelta = {
      atMs: nowMs,
      keys: counters.keys - last.keys,
      clicks: counters.clicks - last.clicks,
      moves: counters.moves - last.moves,
      drawOps: counters.drawOps - last.drawOps,
      inBytes: counters.inBytes - last.inBytes,
    };
    if (delta.keys < 0 || delta.clicks < 0 || delta.moves < 0 || delta.drawOps < 0 || delta.inBytes < 0) {
      rebaseline(nowMs, counters);
      return null;
    }
    last = counters;
    samples.push(delta);
    const windowStartMs = nowMs - VNC_LIVENESS_WINDOW_MS;
    samples = samples.filter((entry) => entry.atMs > windowStartMs);
    if (delta.drawOps > 0) episodeFired = false;
    if (episodeFired) return null;
    if (coveredSinceMs == null || nowMs - coveredSinceMs < VNC_LIVENESS_WINDOW_MS) return null;
    let keys = 0;
    let clicks = 0;
    let moves = 0;
    let drawOps = 0;
    let inBytes = 0;
    for (const entry of samples) {
      keys += entry.keys;
      clicks += entry.clicks;
      moves += entry.moves;
      drawOps += entry.drawOps;
      inBytes += entry.inBytes;
    }
    if (keys + clicks < VNC_LIVENESS_MIN_IMPACTFUL_INPUTS) return null;
    if (drawOps > 0 || inBytes > 0) return null;
    episodeFired = true;
    const oldestUnansweredInput = samples.find((entry) => entry.keys + entry.clicks > 0);
    return {
      phase: "post_connect",
      stallMs: nowMs - (oldestUnansweredInput?.atMs ?? nowMs),
      keys,
      clicks,
      moves,
      inBytes,
    };
  }
  return { sample, reset };
}
