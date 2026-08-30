export interface RipgrepInvocationRecord { [key: string]: unknown }
let handler: ((record: RipgrepInvocationRecord) => void) | undefined;
export function isRipgrepInvocationRecordingEnabled(): boolean { return handler !== undefined; }
export function recordRipgrepInvocation(record: RipgrepInvocationRecord): void {
  if (handler === undefined) return;
  try { handler(record); } catch {}
}
