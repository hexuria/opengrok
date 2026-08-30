import { createRequire } from "node:module";

// The Electron bundle is emitted as CJS while the source owner is also loaded
// directly as ESM by focused tests.  Prefer the CJS filename when present so
// the bundled process-metrics owner does not evaluate an undefined import.meta
// URL; the ESM path remains artifact-equivalent.
const nodeRequire = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
export interface CursorProclistNative { cursor_proclist_scan_async(roots: readonly number[]): Promise<unknown> }

export function loadCursorProclist(requireFn: (name: string) => unknown = nodeRequire): CursorProclistNative | null {
  try {
    const module = requireFn("cursor-proclist") as Partial<CursorProclistNative> | null;
    return typeof module?.cursor_proclist_scan_async === "function" ? module as CursorProclistNative : null;
  } catch { return null; }
}

export function createNativeProcessScan(native: CursorProclistNative | null = loadCursorProclist()): (roots: readonly number[]) => Promise<unknown[]> {
  return async (roots) => {
    if (native == null) return [];
    try { const result = await native.cursor_proclist_scan_async(roots); return Array.isArray(result) ? result : []; }
    catch { return []; }
  };
}
