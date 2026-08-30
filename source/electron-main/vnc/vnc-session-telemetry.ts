export type VncSessionSurface = "preview" | "interactive";
export type VncSessionPhase = "navigate" | "dom_ready" | "load_fail" | "rfb_connect" | "rfb_disconnect" | "reconnect" | "focus";
export type VncFocusOwner = "vnc" | "composer" | "pending";
export interface VncSessionReport { surface: VncSessionSurface; phase: VncSessionPhase; vncHost?: string; display?: string; durationMs?: number; sinceOpenMs?: number; failCode?: string; clean?: boolean; focusOwner?: VncFocusOwner; focusLanded?: boolean }
const VNC_SURFACES = new Set(["preview", "interactive"]);
const VNC_PHASES = new Set(["navigate", "dom_ready", "load_fail", "rfb_connect", "rfb_disconnect", "reconnect", "focus"]);
const VNC_FOCUS_OWNERS = new Set(["vnc", "composer", "pending"]);
const nonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function isValidVncSessionReport(value: unknown): value is VncSessionReport {
  if (typeof value !== "object" || value === null) return false; const r = value as Record<string, unknown>;
  return typeof r.surface === "string" && VNC_SURFACES.has(r.surface) && typeof r.phase === "string" && VNC_PHASES.has(r.phase)
    && (r.vncHost === undefined || typeof r.vncHost === "string") && (r.display === undefined || typeof r.display === "string")
    && (r.durationMs === undefined || nonNegative(r.durationMs)) && (r.sinceOpenMs === undefined || nonNegative(r.sinceOpenMs))
    && (r.failCode === undefined || typeof r.failCode === "string") && (r.clean === undefined || typeof r.clean === "boolean")
    && (r.focusOwner === undefined || typeof r.focusOwner === "string" && VNC_FOCUS_OWNERS.has(r.focusOwner)) && (r.focusLanded === undefined || typeof r.focusLanded === "boolean");
}
export function vncSessionLevel(report: VncSessionReport): "info" | "warn" { if (report.phase === "load_fail" || report.phase === "reconnect") return "warn"; if (report.phase === "rfb_disconnect") return report.clean === false ? "warn" : "info"; if (report.phase === "focus") return report.focusLanded === false ? "warn" : "info"; return "info"; }
export function vncSessionReportToTelemetry(report: VncSessionReport, tokenInfo?: { seeded: boolean; source: string }) { return { level: vncSessionLevel(report), metadata: { surface: report.surface, phase: report.phase, vnc_host: report.vncHost, display: report.display, duration_ms: report.durationMs === undefined ? undefined : String(Math.round(report.durationMs)), since_open_ms: report.sinceOpenMs === undefined ? undefined : String(Math.round(report.sinceOpenMs)), fail_code: report.failCode, clean: report.clean === undefined ? undefined : String(report.clean), focus_owner: report.focusOwner, focus_landed: report.focusLanded === undefined ? undefined : String(report.focusLanded), token_seeded: tokenInfo === undefined ? undefined : String(tokenInfo.seeded), token_source: tokenInfo?.source } }; }
export interface VncLivenessReport { phase: string; stallMs: number; keys: number; clicks: number; moves: number; inBytes: number }
export function vncLivenessReportToTelemetry(report: VncLivenessReport, errorTags: Record<string, string> = {}) { return { level: "warn" as const, metadata: { phase: report.phase, stall_ms: String(Math.round(report.stallMs)), keys: String(Math.round(report.keys)), clicks: String(Math.round(report.clicks)), moves: String(Math.round(report.moves)), in_bytes: String(Math.round(report.inBytes)), ...errorTags } }; }
export interface OpenComputerReport { trigger: "preview" | "handoff" | "teach"; hadVncUrl: boolean; monitorFocused: boolean }
export function isValidOpenComputerReport(value: unknown): value is OpenComputerReport { if (typeof value !== "object" || value == null) return false; const r = value as Record<string, unknown>; return typeof r.trigger === "string" && new Set(["preview", "handoff", "teach"]).has(r.trigger) && typeof r.hadVncUrl === "boolean" && typeof r.monitorFocused === "boolean"; }
export function openComputerReportToTelemetry(report: OpenComputerReport) { return { level: "info" as const, metadata: { trigger: report.trigger, had_vnc_url: String(report.hadVncUrl), monitor_focused: String(report.monitorFocused) } }; }
