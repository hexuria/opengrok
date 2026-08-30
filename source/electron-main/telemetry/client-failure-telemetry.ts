import { isSandClientPersistenceSlice, SAND_QUEUED_FLUSH_CAUSE_CODES } from "../../shared/observability/telemetry.js";

export const CLIENT_RESOURCE_EVENT = "sand.client_resource";
export const RENDERER_UNHANDLED_EVENT = "sand.renderer_unhandled";
export const RENDERER_BOUNDARY_CAUGHT_EVENT = "sand.renderer.boundary_caught";
export const ENTRYPOINT_ERROR_EVENT = "sand.entrypoint_error";
export const SEND_QUEUED_FLUSH_EVENT = "sand.send.queued_flush";
export const CLIENT_PERSISTENCE_EVENT = "sand.client_persistence";
export const CONNECTOR_AUTH_EVENT = "sand.connector_auth";
export const CONNECTOR_AUTH_CLICKED_SERVER_NAME_CAP = 256;

const BOUNDED_TOKEN = /^[0-9A-Za-z._/:|-]{1,64}$/;
const RESOURCE_STATES = new Set(["failed", "recovered"]);
const UNHANDLED_KINDS = new Set(["error", "unhandledrejection"]);
const RENDERER_BOUNDARIES = new Set(["app", "chat_screen", "info_pane", "transcript_row", "mermaid", "other"]);
const ENTRYPOINT_SURFACES = new Set(["workspace", "overlay", "critical"]);
const ENTRYPOINT_PHASES = new Set(["chunk_load", "render"]);
const QUEUED_FAILURE_CAUSES = new Set<string>([SAND_QUEUED_FLUSH_CAUSE_CODES.nonceMismatch, SAND_QUEUED_FLUSH_CAUSE_CODES.capabilityUnavailable, SAND_QUEUED_FLUSH_CAUSE_CODES.hostRejected]);
export const SAND_ERRNO_TAGS = ["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENETRESET", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "EHOSTDOWN", "EAI_AGAIN", "ENOTFOUND", "EADDRINUSE", "EACCES", "EPERM", "ENOENT", "ENOSPC", "EDQUOT", "EROFS", "EBUSY", "EMFILE", "EIO"] as const;
const IO_ERRNO_TAGS = new Set<string>([...SAND_ERRNO_TAGS, "E_OTHER"]);

type RecordValue = Record<string, unknown>;
export interface ClientFailureTelemetry { readonly event: string; readonly level: "info" | "warn" | "error"; readonly metadata: Readonly<Record<string, string | undefined>> }
const recordOf = (value: unknown): RecordValue | undefined => typeof value === "object" && value !== null ? value as RecordValue : undefined;
const token = (value: unknown): value is string => typeof value === "string" && BOUNDED_TOKEN.test(value);
const optionalToken = (value: unknown): boolean => value === undefined || token(value);
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const optionalNonnegative = (value: unknown): boolean => value === undefined || nonnegative(value);
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
const hasCode = (value: unknown, code: string): boolean => recordOf(value)?.code === code;
const boundedIoError = (value: unknown): boolean => hasCode(value, "SAND-E0701") && (recordOf(value)?.errno === undefined || (typeof recordOf(value)?.errno === "string" && IO_ERRNO_TAGS.has(recordOf(value)?.errno as string)));

function validClientResource(r: RecordValue): boolean { return token(r.domain) && token(r.operation) && typeof r.state === "string" && RESOURCE_STATES.has(r.state) && token(r.failureCode) && token(r.boundary) && optionalToken(r.retryOwner) && optionalToken(r.transportKind) && optionalNonnegative(r.failedMs); }
function validRendererUnhandled(r: RecordValue): boolean { return typeof r.handler === "string" && UNHANDLED_KINDS.has(r.handler) && token(r.errorClass) && positiveInteger(r.occurrence); }
function validBoundaryCaught(r: RecordValue): boolean { return typeof r.boundary === "string" && RENDERER_BOUNDARIES.has(r.boundary) && token(r.errorClass) && positiveInteger(r.occurrence); }
function validEntrypoint(r: RecordValue): boolean { return token(r.entrypoint) && typeof r.surface === "string" && ENTRYPOINT_SURFACES.has(r.surface) && typeof r.phase === "string" && ENTRYPOINT_PHASES.has(r.phase) && token(r.errorClass); }
function validQueuedFlush(r: RecordValue): boolean { if (!nonnegative(r.queuedMs) || !nonnegative(r.queueDepth)) return false; if (r.outcome === "delivered") return r.cause === undefined; if (r.outcome === "superseded") return r.cause === SAND_QUEUED_FLUSH_CAUSE_CODES.superseded; if (r.outcome === "expired") return r.cause === SAND_QUEUED_FLUSH_CAUSE_CODES.ackExpired; return r.outcome === "flush_failed" && typeof r.cause === "string" && QUEUED_FAILURE_CAUSES.has(r.cause); }
function validConnectorClicked(r: RecordValue): boolean { return (r.serverName === undefined || typeof r.serverName === "string" && r.serverName.length <= CONNECTOR_AUTH_CLICKED_SERVER_NAME_CAP) && optionalToken(r.serverId); }
function validPersistence(r: RecordValue): boolean { if (!isSandClientPersistenceSlice(r.slice) || !optionalNonnegative(r.bytes)) return false; if (r.op === "writeback") return r.outcome === "ok" && r.error === undefined && r.bytes === undefined; if (r.op === "load") { if (r.outcome === "ok") return r.error === undefined; if (r.outcome === "corrupt") return hasCode(r.error, "SAND-E0700"); return r.outcome === "io_error" && boundedIoError(r.error); } if (r.op !== "persist") return false; if (r.outcome === "quota") return hasCode(r.error, "SAND-E0702"); return r.outcome === "io_error" && boundedIoError(r.error); }

export function isValidClientFailureReport(value: unknown): boolean {
  const r = recordOf(value); if (r === undefined) return false;
  if (r.kind === "client_resource") return validClientResource(r);
  if (r.kind === "renderer_unhandled") return validRendererUnhandled(r);
  if (r.kind === "renderer_boundary_caught") return validBoundaryCaught(r);
  if (r.kind === "entrypoint_error") return validEntrypoint(r);
  if (r.kind === "send_queued_flush") return validQueuedFlush(r);
  if (r.kind === "client_persistence") return validPersistence(r);
  return r.kind === "connector_auth_clicked" && validConnectorClicked(r);
}

const KNOWN_CONNECTORS = new Set(["asana", "atlassian", "buildkite", "confluence", "context7", "databricks", "datadog", "deepwiki", "dock", "figma", "filesystem", "github", "gmail", "google", "googlecalendar", "googledocs", "googledrive", "googlesheets", "googleworkspace", "huggingface", "jira", "linear", "memory", "notion", "playwright", "salesforce", "sentry", "sequentialthinking", "slack", "stripe", "telegram", "todoist", "zoominfo"]);
function connectorTag(name: unknown): string { if (typeof name !== "string") return "unknown"; const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, ""); return normalized.length === 0 ? "unknown" : KNOWN_CONNECTORS.has(normalized) ? normalized : "other"; }
function errorTags(error: unknown): Record<string, string> { const r = recordOf(error); const code = typeof r?.code === "string" && ["SAND-E0700", "SAND-E0701", "SAND-E0702"].includes(r.code) ? r.code : "SAND-E0001"; const retryable = code === "SAND-E0701"; return { error_code: code, error_domain: code === "SAND-E0001" ? "registry" : "storage", error_retryable: String(retryable), ...(code === "SAND-E0701" && typeof r?.errno === "string" ? { errno: IO_ERRNO_TAGS.has(r.errno) ? r.errno : "E_OTHER" } : {}) }; }

export function clientFailureReportToTelemetry(report: any): ClientFailureTelemetry {
  if (report.kind === "client_resource") return { event: CLIENT_RESOURCE_EVENT, level: report.state === "failed" ? "warn" : "info", metadata: { domain: report.domain, operation: report.operation, state: report.state, failure_code: report.failureCode, boundary: report.boundary, retry_owner: report.retryOwner, transport_kind: report.transportKind, failed_ms: report.failedMs === undefined ? undefined : String(Math.round(report.failedMs)) } };
  if (report.kind === "renderer_unhandled") return { event: RENDERER_UNHANDLED_EVENT, level: "error", metadata: { kind: report.handler, error_class: report.errorClass, occurrence: String(report.occurrence) } };
  if (report.kind === "renderer_boundary_caught") return { event: RENDERER_BOUNDARY_CAUGHT_EVENT, level: "warn", metadata: { boundary: report.boundary, error_class: report.errorClass, occurrence: String(report.occurrence) } };
  if (report.kind === "entrypoint_error") return { event: ENTRYPOINT_ERROR_EVENT, level: "warn", metadata: { entrypoint: report.entrypoint, surface: report.surface, phase: report.phase, error_class: report.errorClass } };
  if (report.kind === "send_queued_flush") return { event: SEND_QUEUED_FLUSH_EVENT, level: report.outcome === "expired" || report.outcome === "flush_failed" ? "warn" : "info", metadata: { outcome: report.outcome, queued_ms: String(Math.round(report.queuedMs)), queue_depth: String(Math.round(report.queueDepth)), cause: report.cause } };
  if (report.kind === "connector_auth_clicked") return { event: CONNECTOR_AUTH_EVENT, level: "info", metadata: { phase: "clicked", connector: connectorTag(report.serverName), outcome: "ok", surface: "desktop", server_id: report.serverId } };
  return { event: CLIENT_PERSISTENCE_EVENT, level: report.outcome === "ok" ? "info" : "warn", metadata: { op: report.op, outcome: report.outcome, slice: report.slice, bytes: report.bytes === undefined ? undefined : String(Math.round(report.bytes)), ...(report.error === undefined ? {} : errorTags(report.error)) } };
}
