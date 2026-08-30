const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/;
const HEX_FLAGS = /^[0-9a-f]{2}$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
export const SEND_TRACE_SAMPLE_RATIO = 1;

export interface ParsedTraceparent {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

export function parseTraceparent(traceparent: unknown): ParsedTraceparent | undefined {
  if (typeof traceparent !== "string") return undefined;
  const parts = traceparent.trim().split("-");
  if (parts.length !== 4) return undefined;
  const [version = "", traceId = "", spanId = "", flags = ""] = parts;
  if (version !== "00") return undefined;
  if (!HEX_TRACE_ID.test(traceId) || traceId === ZERO_TRACE_ID) return undefined;
  if (!HEX_SPAN_ID.test(spanId) || spanId === ZERO_SPAN_ID) return undefined;
  if (!HEX_FLAGS.test(flags)) return undefined;
  const traceFlags = Number.parseInt(flags, 16);
  if (Number.isNaN(traceFlags)) return undefined;
  return { traceId, spanId, traceFlags };
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function shouldSampleSend(ratio = SEND_TRACE_SAMPLE_RATIO, random: () => number = Math.random): boolean {
  if (!(ratio > 0)) return false;
  if (ratio >= 1) return true;
  return random() < ratio;
}

export function mintTraceparent(sampled = true): { readonly traceparent: string; readonly traceId: string; readonly spanId: string } | undefined {
  try {
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    return { traceparent: `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`, traceId, spanId };
  } catch { return undefined; }
}

export function deriveChildTraceparent(parent: string): { readonly traceparent: string; readonly spanId: string } | undefined {
  const parsed = parseTraceparent(parent);
  if (parsed === undefined) return undefined;
  try {
    const spanId = randomHex(8);
    const flags = (parsed.traceFlags & 1) === 1 ? "01" : "00";
    return { traceparent: `00-${parsed.traceId}-${spanId}-${flags}`, spanId };
  } catch { return undefined; }
}
