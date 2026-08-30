import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createContext, type Context } from "../../../packages/context/core.js";
import { shellExecutorResource, type ShellExecutor } from "../../../packages/agent-exec/shell.js";
import { IDLE_TEACH_RECORDING_STATUS, SAND_TEACH_MAX_DURATION_MS } from "../../../shared/agents/teach-recording.js";
import { WORKFLOW_REFERENCE_NODE_TYPE } from "../../../shared/workflows.js";
import { SAND_MONITOR_HEIGHT, SAND_MONITOR_WIDTH } from "../../box/box-monitor-layout.js";
import { buildHostShellArgs } from "../../box/box-shell-command.js";
import { SAND_BOX_FIRST_FORK_WINDOW_INDEX, SandBoxNoMonitorAvailableError } from "../../ports/box.js";

export const TEACH_SESSIONS_DIR = "/workspace/teach-sessions";
export const TEACH_QUEUES_DIR = `${TEACH_SESSIONS_DIR}/queues`;
export const LEARN_SKILL_NAME = "learn-from-demonstration";
export const TEACH_PRIVATE_MONITOR_MESSAGE = "Teach recording requires a private desktop monitor.";

export interface Recording { agentId: string; startedAtMs: number; sessionDir: string; displayLabel: string }
export interface PendingRecording { agentId: string; queueFile: string; clientNonce: string }
export interface TeachStatus { state: "idle" | "recording"; agentId?: string | null; startedAtMs?: number | null; maxDurationMs: number }
export interface CapHandle { dispose(): void }
interface ShellAccessor { get(resource: typeof shellExecutorResource): ShellExecutor }
interface TeachBoxConnection { remoteAccessor?: unknown }
export interface TeachRecordingBox {
  ensureReady(ctx: Context, agentId: string): Promise<TeachBoxConnection>;
  getAgentWindowIndex?(agentId: string): number | undefined;
}
export interface TeachRecordingDeps {
  box: TeachRecordingBox;
  isEnabled(): boolean;
  capPolicy: { wrap(fn: () => void): (() => void) & CapHandle };
  sendLearningPrompt(agentId: string, prompt: { content: string; richText: string; clientNonce: string }): Promise<void>;
  listAgentIds(): Promise<readonly string[]>;
  queueSignatureKey(): Promise<Uint8Array>;
  ensureLearningWorkflow(): Promise<boolean>;
  trackRecordingStarted(event: Record<string, unknown>): void;
  trackRecordingStopped(event: Record<string, unknown>): void;
  reportStartFailed(event: Record<string, unknown>): void;
  reportCapStopFailed(event: Record<string, unknown>): void;
}

export class SandTeachRecordingError extends Error {
  constructor(readonly kind: string, message: string) { super(message); this.name = "SandTeachRecordingError"; }
}

export const isForkWindowIndex = (index: number | null | undefined): boolean => index != null && Number.isInteger(index) && index >= SAND_BOX_FIRST_FORK_WINDOW_INDEX;
export const queueScope = (agentId: string): string => createHash("sha256").update(agentId).digest("hex");
export const signQueueEntry = (key: Uint8Array, agentId: string, file: string): string => createHmac("sha256", key).update(`${agentId}\n${file}`).digest("hex");
export const queueFileForSessionDir = (dir: string): string => `${dir.split("/").at(-1) ?? ""}.json`;
export const learningPromptNonce = (recording: Recording): string => `teach-recording:${queueScope(recording.agentId)}:${queueFileForSessionDir(recording.sessionDir)}`;
export function learningPromptRichText(agentId: string): string { return JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: WORKFLOW_REFERENCE_NODE_TYPE, attrs: { id: LEARN_SKILL_NAME, label: "Learn from demonstration", teachQueueScope: queueScope(agentId) } }] }] }); }

function startFailureKind(error: unknown): string {
  if (error instanceof SandTeachRecordingError) return error.kind;
  if (error instanceof SandBoxNoMonitorAvailableError) return "no_monitor";
  return "box";
}

function requireShell(connection: TeachBoxConnection): ShellAccessor {
  const accessor = connection.remoteAccessor as Partial<ShellAccessor> | null | undefined;
  if (typeof accessor?.get !== "function") throw new SandTeachRecordingError("shell", "teach-recording: box shell accessor is unavailable");
  return accessor as ShellAccessor;
}

export function createTeachRecordingService(deps: TeachRecordingDeps) {
  const ctx = createContext().withName("teachRecording"), listeners = new Set<(status: TeachStatus) => void>();
  let active: Recording | null = null, failedStart: Recording | null = null;
  let startInFlight: Promise<TeachStatus> | null = null, stopInFlight: Promise<TeachStatus> | null = null, disposeInFlight: Promise<void> | null = null;
  let capWake: ((() => void) & CapHandle) | null = null, isDisposing = false, queuePersisted = false;
  type FinalizationState = { endedAtMs: number; intent: "save" | "discard"; phase: "preparing" | "winding-down" | "checking-workflow" | "dispatching-prompt" };
  let finalizing: FinalizationState | null = null;
  let queueKeyPromise: Promise<Uint8Array> | null = null;
  const queueKey = (): Promise<Uint8Array> => queueKeyPromise ??= deps.queueSignatureKey();
  const statusOf = (): TeachStatus => active == null ? IDLE_TEACH_RECORDING_STATUS : { state: "recording", agentId: active.agentId, startedAtMs: active.startedAtMs, maxDurationMs: SAND_TEACH_MAX_DURATION_MS };
  const emit = (): void => { const status = statusOf(); for (const listener of listeners) listener(status); };
  const runShell = async (connection: TeachBoxConnection, command: string, toolCallId: string) => {
    const result = await requireShell(connection).get(shellExecutorResource).execute(ctx, buildHostShellArgs({ command, name: "bash", workingDirectory: "/workspace", toolCallId }));
    if (result.result.case !== "success") throw new SandTeachRecordingError("shell", `teach-recording shell failed: ${result.result.case}`);
    return result.result.value;
  };
  const sessionJson = (recording: Recording, end?: { endedAtMs: number; endReason: string }): string => JSON.stringify({ startedAt: new Date(recording.startedAtMs).toISOString(), display: recording.displayLabel, maxDurationMs: SAND_TEACH_MAX_DURATION_MS, videoPath: `${recording.sessionDir}/demo.mp4`, ffmpegPid: "__FFMPEG_PID__", ...(end == null ? {} : { endedAt: new Date(end.endedAtMs).toISOString(), endReason: end.endReason }) }, null, 2).replace('"__FFMPEG_PID__"', "$pid");
  const completedSessionJson = (recording: Recording, endedAtMs: number, signature: string): string => JSON.stringify({ agentId: recording.agentId, sessionDir: recording.sessionDir, clientNonce: learningPromptNonce(recording), signature, startedAt: new Date(recording.startedAtMs).toISOString(), endedAt: new Date(endedAtMs).toISOString() }, null, 2);
  const queueFile = (recording: Recording): string => queueFileForSessionDir(recording.sessionDir);
  const ffmpegCmdlineOwnsVideo = (pidExpr: string, videoPath: string): string => `kill -0 ${pidExpr} 2>/dev/null && tr '\\0' ' ' < /proc/${pidExpr}/cmdline 2>/dev/null | grep -qF ${JSON.stringify(videoPath)}`;
  const discardRecording = (connection: TeachBoxConnection, recording: Recording, verifyCmdline: string) => runShell(connection, [
    `pid=$(tr -d '[:space:]' < ${recording.sessionDir}/ffmpeg.pid 2>/dev/null || true)`,
    `if [ -n "$pid" ] && ${verifyCmdline}; then`, "  kill -INT \"$pid\" || true", "  sleep 1", `  if ${verifyCmdline}; then kill -KILL "$pid" || true; fi`,
    "  for _ in 1 2 3 4 5; do", `    if ! ( ${verifyCmdline} ); then break; fi`, "    sleep 0.2", "  done", `  if ${verifyCmdline}; then`, `    : > ${recording.sessionDir}/startup.invalid`, "    exit 1", "  fi", "fi",
    `queue_dir=${TEACH_QUEUES_DIR}/${queueScope(recording.agentId)}`, `queue_file="$queue_dir/pending/${queueFile(recording)}"`, `rm -f "$queue_file" "$queue_file.prompt-delivered" "$queue_dir/claimed/${queueFile(recording)}"`, `rm -rf ${recording.sessionDir}`
  ].join("\n"), "sand-teach-recording-discard");
  const cleanupFailedStart = async (connection: TeachBoxConnection, recording: Recording): Promise<void> => {
    const result = await discardRecording(connection, recording, ffmpegCmdlineOwnsVideo('"$pid"', `${recording.sessionDir}/demo.mp4`));
    if (result.exitCode !== 0) throw new SandTeachRecordingError("cleanup_failed", `teach-recording: failed to clean up recording startup: ${result.stdout} ${result.stderr}`);
  };
  const recoverFailedStart = async (): Promise<void> => { const recording = failedStart; if (recording == null) return; await cleanupFailedStart(await deps.box.ensureReady(ctx, recording.agentId), recording); if (failedStart === recording) failedStart = null; };
  const disposeCap = (): void => { capWake?.dispose(); capWake = null; };
  const armCap = (recording: Recording): void => {
    if (isDisposing || capWake != null) return;
    capWake = deps.capPolicy.wrap(() => { capWake = null; if (!isDisposing) void stop({ agentId: recording.agentId, save: true, trackCompletion: true }).catch(error => deps.reportCapStopFailed({ errorClass: error instanceof Error ? error.name || "Error" : "unknown" })); });
    capWake();
  };
  const markPromptDelivered = async (connection: TeachBoxConnection, pending: PendingRecording): Promise<void> => {
    const result = await runShell(connection, [`queue_dir=${TEACH_QUEUES_DIR}/${queueScope(pending.agentId)}`, `queue_file="$queue_dir/pending/${pending.queueFile}"`, `if [ -f "$queue_file" ]; then : > "$queue_file.prompt-delivered"; fi`].join("\n"), "sand-teach-recording-mark-prompt-delivered");
    if (result.exitCode !== 0) throw new SandTeachRecordingError("mark_prompt_failed", `teach-recording: failed to mark learning prompt delivered: ${result.stdout} ${result.stderr}`);
  };
  const pendingRecording = (agentId: string, key: Uint8Array, queuedFile: string, content: string): PendingRecording | null => {
    try {
      const value = JSON.parse(Buffer.from(content, "base64").toString("utf8")) as Record<string, unknown>;
      const sessionDir = `${TEACH_SESSIONS_DIR}/${queuedFile.slice(0, -5)}`, clientNonce = `teach-recording:${queueScope(agentId)}:${queuedFile}`;
      if (value == null || typeof value !== "object" || value.agentId !== agentId || value.sessionDir !== sessionDir || value.clientNonce !== clientNonce || typeof value.signature !== "string" || !/^[0-9a-f]{64}$/.test(value.signature)) return null;
      const expected = Buffer.from(signQueueEntry(key, agentId, queuedFile), "hex"), given = Buffer.from(value.signature, "hex");
      return given.length === expected.length && timingSafeEqual(given, expected) ? { agentId, queueFile: queuedFile, clientNonce } : null;
    } catch { return null; }
  };
  const queueScanCommand = (glob: string): string => [
    `for queue_file in ${glob}; do`, `  [ -f "$queue_file" ] || continue`, `  if [ -e "$queue_file.prompt-delivered" ]; then marker=1; else marker=0; fi`, `  printf '%s\\t%s\\t%s\\t' "$(basename "$(dirname "$(dirname "$queue_file")")")" "$(basename "$queue_file")" "$marker"`, `  base64 "$queue_file" | tr -d '\\n'`, "  printf '\\n'", "done"
  ].join("\n");
  type QueueScan = { scope: string; queueFile: string; delivered: boolean; recording: PendingRecording | null };
  const parseQueueScan = (stdout: string, key: Uint8Array, agentsByScope: ReadonlyMap<string, string>): QueueScan[] => stdout.split("\n").map(line => {
    const [scope, queuedFile, marker, content, ...rest] = line.split("\t");
    if (rest.length > 0 || scope == null || queuedFile == null || marker == null || content == null || !/^[0-9a-f]{64}$/.test(scope) || !/^teach-\d{8}T\d{6}Z-[0-9a-f-]{36}\.json$/.test(queuedFile) || marker !== "0" && marker !== "1") return null;
    const agentId = agentsByScope.get(scope); return agentId == null ? null : { scope, queueFile: queuedFile, delivered: marker === "1", recording: pendingRecording(agentId, key, queuedFile, content) };
  }).filter((entry): entry is QueueScan => entry != null);
  const quarantineQueueFiles = async (connection: TeachBoxConnection, entries: readonly Pick<QueueScan, "scope" | "queueFile">[]): Promise<void> => {
    if (entries.length === 0) return;
    const result = await runShell(connection, entries.flatMap(({ scope, queueFile: file }) => { const dir = `${TEACH_QUEUES_DIR}/${scope}`; return [`mkdir -p ${dir}/rejected`, `mv -f ${dir}/pending/${file} ${dir}/rejected/${file} 2>/dev/null || true`, `rm -f ${dir}/pending/${file}.prompt-delivered`]; }).join("\n"), "sand-teach-recording-quarantine");
    if (result.exitCode !== 0) throw new SandTeachRecordingError("quarantine_failed", `teach-recording: failed to quarantine forged queue entries: ${result.stdout} ${result.stderr}`);
  };
  const ensureAuthenticQueue = async (connection: TeachBoxConnection, agentId: string): Promise<void> => {
    const key = await queueKey(), scope = queueScope(agentId), result = await runShell(connection, queueScanCommand(`${TEACH_QUEUES_DIR}/${scope}/pending/*.json`), "sand-teach-recording-verify");
    if (result.exitCode !== 0) throw new SandTeachRecordingError("finalize_failed", `teach-recording: failed to verify queue authenticity: ${result.stdout} ${result.stderr}`);
    await quarantineQueueFiles(connection, parseQueueScan(result.stdout, key, new Map([[scope, agentId]])).filter(entry => entry.recording == null));
  };
  const recoverPending = async (): Promise<void> => {
    if (!deps.isEnabled()) return;
    const agentIds = await deps.listAgentIds(), firstAgentId = agentIds[0]; if (firstAgentId == null) return;
    const agentsByScope = new Map(agentIds.map(agentId => [queueScope(agentId), agentId])), key = await queueKey(), connection = await deps.box.ensureReady(ctx, firstAgentId);
    const result = await runShell(connection, queueScanCommand(`${TEACH_QUEUES_DIR}/*/pending/*.json`), "sand-teach-recording-recover");
    if (result.exitCode !== 0) throw new SandTeachRecordingError("recover_failed", `teach-recording: failed to recover pending recordings: ${result.stdout} ${result.stderr}`);
    const entries = parseQueueScan(result.stdout, key, agentsByScope); await quarantineQueueFiles(connection, entries.filter(entry => entry.recording == null));
    const pending = entries.flatMap(entry => entry.recording != null && !entry.delivered ? [entry.recording] : []); if (pending.length === 0 || !await deps.ensureLearningWorkflow()) return;
    for (const recording of pending) { await deps.sendLearningPrompt(recording.agentId, { content: "The recording is finished. Learn the task from it.", richText: learningPromptRichText(recording.agentId), clientNonce: recording.clientNonce }); await markPromptDelivered(connection, recording); }
  };
  const startRecording = async (args: { agentId: string; entryPoint?: string }): Promise<TeachStatus> => {
    await recoverFailedStart(); const connection = await deps.box.ensureReady(ctx, args.agentId), windowIndex = deps.box.getAgentWindowIndex?.(args.agentId);
    if (!isForkWindowIndex(windowIndex)) throw new SandBoxNoMonitorAvailableError(TEACH_PRIVATE_MONITOR_MESSAGE);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const recording: Recording = { agentId: args.agentId, startedAtMs: Date.now(), sessionDir: `${TEACH_SESSIONS_DIR}/teach-${stamp}-${randomUUID()}`, displayLabel: `:${windowIndex}` };
    const videoPath = `${recording.sessionDir}/demo.mp4`, maxSeconds = Math.round(SAND_TEACH_MAX_DURATION_MS / 1_000), inputArgs = `-video_size ${SAND_MONITOR_WIDTH}x${SAND_MONITOR_HEIGHT} -i :${windowIndex}.0`; failedStart = recording;
    try {
      const result = await runShell(connection, [`mkdir -p ${recording.sessionDir}`, `nohup ffmpeg -y -v error -f x11grab ${inputArgs} -framerate 15 -t ${maxSeconds} -c:v libx264 -preset ultrafast -g 75 -pix_fmt yuv420p -an ${videoPath} > ${recording.sessionDir}/ffmpeg.log 2>&1 &`, `printf '%s\\n' "$!" > ${recording.sessionDir}/ffmpeg.pid`, "sleep 0.4", `pid=$(tr -d '[:space:]' < ${recording.sessionDir}/ffmpeg.pid)`, `case "$pid" in ''|*[!0-9]*) cat ${recording.sessionDir}/ffmpeg.log; exit 1 ;; esac`, `${ffmpegCmdlineOwnsVideo('"$pid"', videoPath)} || { cat ${recording.sessionDir}/ffmpeg.log; exit 1; }`, `cat > ${recording.sessionDir}/session.json <<SESSION_JSON`, sessionJson(recording), "SESSION_JSON"].join("\n"), "sand-teach-recording-start");
      if (result.exitCode !== 0) throw new SandTeachRecordingError("start_failed", `teach-recording: ffmpeg failed to start: ${result.stdout} ${result.stderr}`);
    } catch (error) {
      try { await cleanupFailedStart(connection, recording); if (failedStart === recording) failedStart = null; } catch (cleanupError) { throw new SandTeachRecordingError("cleanup_failed", `teach-recording: ffmpeg startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
      throw error;
    }
    if (failedStart === recording) failedStart = null; active = recording; queuePersisted = false; armCap(recording); deps.trackRecordingStarted({ agent_id: args.agentId, entry_point: args.entryPoint }); emit(); return statusOf();
  };
  const reportStartFailure = (args: { agentId: string; entryPoint?: string }, error: unknown): void => deps.reportStartFailed({ kind: startFailureKind(error), errorClass: error instanceof Error ? error.name || "Error" : "unknown", windowIndex: deps.box.getAgentWindowIndex?.(args.agentId), entryPoint: args.entryPoint });
  const start = async (args: { agentId: string; entryPoint?: string }): Promise<TeachStatus> => {
    if (isDisposing) { const error = new SandTeachRecordingError("shutting_down", "teach-recording: recording service is shutting down"); reportStartFailure(args, error); throw error; }
    if (!deps.isEnabled()) { const error = new SandTeachRecordingError("disabled", "teach-recording: the feature gate is off"); reportStartFailure(args, error); throw error; }
    if (active != null) return statusOf(); if (startInFlight != null) return startInFlight;
    const startup = startRecording(args); startInFlight = startup; try { return await startup; } catch (error) { reportStartFailure(args, error); throw error; } finally { if (startInFlight === startup) startInFlight = null; }
  };
  const stop = async ({ agentId, save, trackCompletion }: { agentId: string; save: boolean; trackCompletion: boolean }): Promise<TeachStatus> => {
    const recording = active; if (recording != null && recording.agentId !== agentId) throw new SandTeachRecordingError("agent_mismatch", "teach-recording: recording belongs to a different agent");
    if (finalizing != null) { if (!save && finalizing.phase !== "dispatching-prompt") finalizing.intent = "discard"; return await stopInFlight ?? statusOf(); }
    if (recording == null) return statusOf();
    const state: FinalizationState = { endedAtMs: Date.now(), intent: save ? "save" : "discard", phase: "preparing" }; finalizing = state;
    const operation = (async (): Promise<TeachStatus> => {
      const connection = await deps.box.ensureReady(ctx, recording.agentId), videoPath = `${recording.sessionDir}/demo.mp4`, readPid = `pid=$(tr -d '[:space:]' < ${recording.sessionDir}/ffmpeg.pid) || exit 1`, validatePid = `case "$pid" in ''|*[!0-9]*) exit 1 ;; esac`, verifyCmdline = ffmpegCmdlineOwnsVideo('"$pid"', videoPath), shouldDiscard = () => state.intent === "discard";
      state.phase = "winding-down"; const windDownWasSave = state.intent === "save", signature = windDownWasSave ? signQueueEntry(await queueKey(), recording.agentId, queueFile(recording)) : "";
      const windDown = windDownWasSave ? runShell(connection, ["set -e", readPid, validatePid, `if ${verifyCmdline}; then kill -INT "$pid"; fi`, `cat > ${recording.sessionDir}/session.json <<SESSION_JSON`, sessionJson(recording, { endedAtMs: state.endedAtMs, endReason: "stopped" }), "SESSION_JSON", `queue_dir=${TEACH_QUEUES_DIR}/${queueScope(recording.agentId)}`, `queue_file="$queue_dir/pending/${queueFile(recording)}"`, `mkdir -p "$queue_dir/pending" "$queue_dir/claimed"`, `cat > "$queue_file.tmp.$$" <<COMPLETED_SESSION_JSON`, completedSessionJson(recording, state.endedAtMs, signature), "COMPLETED_SESSION_JSON", `if [ ! -e "$queue_file" ] && [ ! -e "$queue_dir/claimed/$(basename "$queue_file")" ]; then mv "$queue_file.tmp.$$" "$queue_file"; else rm -f "$queue_file.tmp.$$"; fi`].join("\n"), "sand-teach-recording-stop") : discardRecording(connection, recording, verifyCmdline);
      const result = await windDown; queuePersisted = windDownWasSave && result.exitCode === 0;
      if (shouldDiscard() && windDownWasSave) { const discarded = await discardRecording(connection, recording, verifyCmdline); queuePersisted = false; if (discarded.exitCode !== 0) throw new SandTeachRecordingError("finalize_failed", `teach-recording: failed to finalize recording: ${discarded.stdout} ${discarded.stderr}`); }
      else if (result.exitCode !== 0) throw new SandTeachRecordingError("finalize_failed", `teach-recording: failed to finalize recording: ${result.stdout} ${result.stderr}`);
      if (!shouldDiscard()) {
        state.phase = "checking-workflow"; const workflowAvailable = await deps.ensureLearningWorkflow();
        if (shouldDiscard()) { const discarded = await discardRecording(connection, recording, verifyCmdline); queuePersisted = false; if (discarded.exitCode !== 0) throw new SandTeachRecordingError("finalize_failed", `teach-recording: failed to finalize recording: ${discarded.stdout} ${discarded.stderr}`); }
        else if (!workflowAvailable) throw new SandTeachRecordingError("workflow_unavailable", "teach-recording: learning workflow is unavailable");
        else { state.phase = "dispatching-prompt"; await ensureAuthenticQueue(connection, recording.agentId); const pending = { agentId: recording.agentId, queueFile: queueFile(recording), clientNonce: learningPromptNonce(recording) }; await deps.sendLearningPrompt(recording.agentId, { content: "The recording is finished. Learn the task from it.", richText: learningPromptRichText(recording.agentId), clientNonce: pending.clientNonce }); await markPromptDelivered(connection, pending); }
      }
      active = null; disposeCap(); emit(); if (trackCompletion) deps.trackRecordingStopped({ agent_id: recording.agentId, outcome: state.intent === "save" ? "saved" : "discarded", duration_seconds: Math.round((state.endedAtMs - recording.startedAtMs) / 1_000) }); return statusOf();
    })();
    stopInFlight = operation; try { return await operation; } finally { if (stopInFlight === operation) stopInFlight = null; if (finalizing === state) finalizing = null; if (active === recording && !isDisposing) armCap(recording); }
  };
  const dispose = (): Promise<void> => {
    if (disposeInFlight != null) return disposeInFlight; isDisposing = true;
    const teardown = (async (): Promise<void> => { try { if (startInFlight != null) try { await startInFlight; } catch { await recoverFailedStart(); } if (stopInFlight != null) try { await stopInFlight; } catch { if (active != null && !queuePersisted) await stop({ agentId: active.agentId, save: false, trackCompletion: false }); } else if (active != null && !queuePersisted) await stop({ agentId: active.agentId, save: false, trackCompletion: false }); } finally { disposeCap(); listeners.clear(); } })();
    disposeInFlight = teardown; return teardown;
  };
  return { api: { start, stop: ({ agentId, save }: { agentId: string; save: boolean }) => stop({ agentId, save, trackCompletion: true }), getStatus: statusOf, subscribe(listener: (status: TeachStatus) => void) { listeners.add(listener); return () => listeners.delete(listener); } }, recoverPending, dispose };
}
