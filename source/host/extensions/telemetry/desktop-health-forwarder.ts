export const DESKTOP_COMPONENT_NAME_PATTERN =
  /^(d[1-9][0-9]*|shared)\/(xvfb|xfwm4|picom|x11vnc|websockify|dock|fork-websockify|fork-router|egress-proxy)$/;
export const MAX_DOWN_DETAIL_LENGTH = 256,
  MAX_COMPONENT_RESTARTS = 10_000;
const componentKinds = new Set([
  "xvfb",
  "xfwm4",
  "picom",
  "x11vnc",
  "websockify",
  "dock",
  "fork-websockify",
  "fork-router",
  "egress-proxy",
]);
const downReasons = new Set([
  "port-in-use",
  "x-server-active",
  "already-running",
  "no-display",
  "oom",
  "glx",
  "x-io-error",
  "fatal-server",
  "awaiting-dependency",
  "compositor-disabled",
  "port-not-listening",
  "listener-procfs-unavailable",
  "unknown",
]);
export interface DesktopComponentHealth {
  name: string;
  up: boolean;
  crashloop: boolean;
  restartsInWindow: number;
  downReason?: string;
}
export interface DesktopHealthSnapshot {
  updatedAtMs: number;
  revision: number;
  supervisionEnabled: boolean;
  total: number;
  up: number;
  down: number;
  crashlooping: number;
  restartsInWindow: number;
  components: DesktopComponentHealth[];
}
export function normalizeDesktopComponentName(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = DESKTOP_COMPONENT_NAME_PATTERN.exec(value),
    group = match?.[1],
    kind = match?.[2];
  if (group === undefined || kind === undefined || !componentKinds.has(kind))
    return undefined;
  let scope = "fork";
  if (group === "d1") scope = "primary";
  if (group === "shared") scope = "shared";
  return `${scope}/${kind}`;
}
export function normalizeDesktopDownReason(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (downReasons.has(value)) return value;
  if (/^signal-SIG[A-Z0-9]+$/.test(value)) return "signal";
  if (/^exit--?[0-9]+$/.test(value)) return "exit";
  return "unknown";
}
export function normalizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return 0;
  return Math.min(value, MAX_COMPONENT_RESTARTS);
}
export function mergeDesktopComponentHealth(
  current: DesktopComponentHealth,
  next: DesktopComponentHealth,
): DesktopComponentHealth {
  const up = current.up && next.up,
    a = current.downReason,
    b = next.downReason;
  let downReason = b ?? a ?? "unknown";
  if (a !== undefined && b !== undefined && a !== b) downReason = "multiple";
  return {
    name: current.name,
    up,
    crashloop: current.crashloop || next.crashloop,
    restartsInWindow: Math.min(
      MAX_COMPONENT_RESTARTS,
      current.restartsInWindow + next.restartsInWindow,
    ),
    ...(!up ? { downReason } : {}),
  };
}
export function parseDesktopHealthSnapshot(
  raw: string,
): DesktopHealthSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.revision !== "number" ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    typeof v.updatedAtMs !== "number" ||
    !Number.isSafeInteger(v.updatedAtMs) ||
    v.updatedAtMs < 0 ||
    !Array.isArray(v.components)
  )
    return null;
  const byName = new Map<string, DesktopComponentHealth>();
  for (const entry of v.components) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>,
      name = normalizeDesktopComponentName(e.name);
    if (name === undefined) continue;
    const downReason = normalizeDesktopDownReason(e.downReason),
      component: DesktopComponentHealth = {
        name,
        up: e.up === true,
        crashloop: e.crashloop === true,
        restartsInWindow: normalizeCount(e.restartsInWindow),
        ...(downReason !== undefined ? { downReason } : {}),
      };
    const current = byName.get(name);
    byName.set(
      name,
      current === undefined
        ? component
        : mergeDesktopComponentHealth(current, component),
    );
  }
  const components = [...byName.values()],
    total = components.length,
    up = components.filter((c) => c.up).length,
    crashlooping = components.filter((c) => c.crashloop).length,
    restartsInWindow = components.reduce((n, c) => n + c.restartsInWindow, 0);
  return {
    updatedAtMs: v.updatedAtMs,
    revision: v.revision,
    supervisionEnabled: v.supervisionEnabled === true,
    total,
    up,
    down: Math.max(0, total - up),
    crashlooping,
    restartsInWindow,
    components,
  };
}
export function desktopHealthOverall(
  snapshot: DesktopHealthSnapshot,
): "crashloop" | "degraded" | "healthy" {
  if (snapshot.crashlooping > 0) return "crashloop";
  if (snapshot.down > 0) return "degraded";
  return "healthy";
}
export function desktopHealthLevel(
  overall: ReturnType<typeof desktopHealthOverall>,
): "info" | "warn" {
  return overall === "healthy" ? "info" : "warn";
}
export function computeDesktopHealthMetadata(snapshot: DesktopHealthSnapshot) {
  const overall = desktopHealthOverall(snapshot),
    problems = snapshot.components.filter((c) => !c.up || c.crashloop);
  const downDetail =
    problems.length > 0
      ? problems
          .map((c) => (c.crashloop ? `${c.name}(crashloop)` : c.name))
          .join(",")
          .slice(0, MAX_DOWN_DETAIL_LENGTH)
      : undefined;
  const withReason = problems.filter(
    (c) => typeof c.downReason === "string" && c.downReason.length > 0,
  );
  const downReason =
    withReason.length > 0
      ? withReason
          .map((c) => `${c.name}=${c.downReason}`)
          .join(",")
          .slice(0, MAX_DOWN_DETAIL_LENGTH)
      : undefined;
  return {
    supervision_enabled: String(snapshot.supervisionEnabled),
    overall,
    total: String(snapshot.total),
    up: String(snapshot.up),
    down: String(snapshot.down),
    crashlooping: String(snapshot.crashlooping),
    restarts_window: String(snapshot.restartsInWindow),
    down_detail: downDetail,
    down_reason: downReason,
  };
}
export function decideDesktopHealthForward(args: {
  lastForwardedRevision: number | null;
  lastForwardedAtMs: number | null;
  revision: number;
  nowMs: number;
  heartbeatMs: number;
}): boolean {
  if (args.lastForwardedRevision === null || args.lastForwardedAtMs === null)
    return true;
  if (args.revision !== args.lastForwardedRevision) return true;
  return args.nowMs - args.lastForwardedAtMs >= args.heartbeatMs;
}
export async function forwardDesktopHealthWith(deps: {
  readRaw(): Promise<string | null>;
  getLast(): { revision: number | null; atMs: number | null };
  now(): number;
  heartbeatMs: number;
  emit(
    level: "info" | "warn",
    metadata: ReturnType<typeof computeDesktopHealthMetadata>,
  ): void;
  setLast(revision: number, atMs: number): void;
}): Promise<"absent" | "parse_error" | "skipped" | "emitted"> {
  const raw = await deps.readRaw();
  if (raw == null) return "absent";
  const snapshot = parseDesktopHealthSnapshot(raw);
  if (snapshot == null) return "parse_error";
  const last = deps.getLast(),
    nowMs = deps.now();
  if (
    !decideDesktopHealthForward({
      revision: snapshot.revision,
      lastForwardedRevision: last.revision,
      lastForwardedAtMs: last.atMs,
      nowMs,
      heartbeatMs: deps.heartbeatMs,
    })
  )
    return "skipped";
  const metadata = computeDesktopHealthMetadata(snapshot);
  deps.emit(desktopHealthLevel(desktopHealthOverall(snapshot)), metadata);
  deps.setLast(snapshot.revision, nowMs);
  return "emitted";
}
