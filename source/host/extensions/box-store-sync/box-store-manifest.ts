import { existsSync } from "node:fs";
import { z } from "zod";
import type { RetryPolicy } from "../../../internal/scheduling.js";
import { errorMessage } from "../../../shared/errors.js";
import { invariant } from "../../../shared/invariant.js";
import { BOX_STORE_LEGACY_MANIFEST_VERSION, BOX_STORE_MANIFEST_REL_PATH, BOX_STORE_MANIFEST_VERSION, boxStoreManifestEntriesEqual, isSymlinkManifestValue, manifestSchema, type BoxStoreManifestEntry } from "./box-store-manifest-format.js";
import { isHydrationHandoffManifestPath, removeHydrationHandoffMarker, writeHydrationHandoffMarker } from "./box-store-hydration.js";
import type { BoxObjectStoreProvider } from "./box-object-store.js";
import { BoxStoreCanonicalWriteConflictError } from "./object-store-port.js";
import { SandBoxStoreSyncError } from "./box-store-sync-error.js";
import type { StoreDbCaptureTrace } from "./store-db-bundle-capture.js";

export const AGENT_STORE_DB_BASENAMES = ["store.db", "conversation-blobs.db"] as const;
export const STORE_DB_MANIFEST_KEY_RE = /^home\/box\/sand-data\/agents\/([^/]+)\/store\.db$/;
export const AGENT_DIR_MANIFEST_KEY_RE = /^home\/box\/sand-data\/agents\/([^/]+)\//;
export type BoxManifestMap = Map<string, BoxStoreManifestEntry>;

export function countStoreDbManifestEntries(manifest: ReadonlyMap<string, unknown> | null | undefined): number {
  if (manifest == null) return 0;
  let count = 0;
  for (const [relPath, entry] of manifest) if (STORE_DB_MANIFEST_KEY_RE.test(relPath) && !isSymlinkManifestValue(entry)) count += 1;
  return count;
}
export function getStoreDbManifestAgentIds(manifest: ReadonlyMap<string, unknown> | null): Set<string> {
  const agentIds = new Set<string>();
  for (const [relPath, entry] of manifest ?? []) { const match = STORE_DB_MANIFEST_KEY_RE.exec(relPath); if (match?.[1] != null && !isSymlinkManifestValue(entry)) agentIds.add(match[1]); }
  return agentIds;
}
export function countAgentDirManifestEntries(manifest: ReadonlyMap<string, unknown> | null | undefined): number {
  if (manifest == null) return 0;
  const ids = new Set<string>();
  for (const relPath of manifest.keys()) { const match = AGENT_DIR_MANIFEST_KEY_RE.exec(relPath); if (match != null) ids.add(match[1]!); }
  return ids.size;
}

const manifestVersionSchema = z.object({ version: z.number().int() });
export class BoxStoreUnsupportedManifestVersionError extends SandBoxStoreSyncError { constructor(readonly version: number) { super(`unsupported box store manifest version ${version}`); } }
export class BoxStoreManifestPathConflictError extends SandBoxStoreSyncError { constructor() { super("box store manifest contains conflicting node paths"); } }
export function hasManifestPathConflict(entries: Record<string, unknown>): boolean {
  const relPaths = new Set(Object.keys(entries));
  for (const relPath of relPaths) for (let separatorIndex = relPath.indexOf("/"); separatorIndex >= 0; separatorIndex = relPath.indexOf("/", separatorIndex + 1)) if (relPaths.has(relPath.slice(0, separatorIndex))) return true;
  return false;
}
export type DecodedManifest = z.infer<typeof manifestSchema>;
export function parseManifest(bytes: Uint8Array, onWriteBlockedError?: (error: Error) => void): DecodedManifest | null {
  const invalidJson = Symbol(); let value: unknown | typeof invalidJson;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { value = invalidJson; }
  if (value === invalidJson) return null;
  const header = manifestVersionSchema.safeParse(value);
  if (header.success && header.data.version !== BOX_STORE_LEGACY_MANIFEST_VERSION && header.data.version !== BOX_STORE_MANIFEST_VERSION) { const error = new BoxStoreUnsupportedManifestVersionError(header.data.version); onWriteBlockedError?.(error); throw error; }
  const parsed = manifestSchema.safeParse(value); if (!parsed.success) return null;
  if (hasManifestPathConflict(parsed.data.entries)) { const error = new BoxStoreManifestPathConflictError(); onWriteBlockedError?.(error); throw error; }
  return parsed.data;
}

interface ManifestCapture { revision: number; entries: Record<string, BoxStoreManifestEntry> }
export class BoxStoreManifestRevisionState {
  private revisionValue = 0;
  private pendingRevisionCounts = new Map<number, number>();
  private constructionCount = 0;
  constructor(private persisted?: { revision: number; fullyHydrated?: boolean | undefined }) {}
  get revision(): number { return this.revisionValue; }
  get persistedRevision(): number | undefined { return this.persisted?.revision; }
  get snapshotConstructionCount(): number { return this.constructionCount; }
  get hasPendingWriteForRevision(): boolean { return (this.pendingRevisionCounts.get(this.revisionValue) ?? 0) > 0; }
  markChanged(): void { this.revisionValue += 1; }
  capture(manifest: ReadonlyMap<string, BoxStoreManifestEntry>, fullyHydrated: boolean | undefined, isRequiredWrite: boolean): ManifestCapture | null {
    if (!isRequiredWrite && ((this.pendingRevisionCounts.get(this.revisionValue) ?? 0) > 0 || this.persisted?.revision === this.revisionValue && this.persisted.fullyHydrated === fullyHydrated)) return null;
    const entries: Record<string, BoxStoreManifestEntry> = {}; for (const [relPath, entry] of manifest) entries[relPath] = entry;
    this.constructionCount += 1; this.pendingRevisionCounts.set(this.revisionValue, (this.pendingRevisionCounts.get(this.revisionValue) ?? 0) + 1);
    return { revision: this.revisionValue, entries };
  }
  markPersisted(capture: ManifestCapture, fullyHydrated: boolean | undefined): void { this.persisted = { revision: capture.revision, fullyHydrated }; }
  markFailed(): void { this.persisted = undefined; }
  release(capture: ManifestCapture): void { const count = this.pendingRevisionCounts.get(capture.revision); if (count == null || count <= 1) this.pendingRevisionCounts.delete(capture.revision); else this.pendingRevisionCounts.set(capture.revision, count - 1); }
}

export class ManifestRetryStoppedError extends Error { constructor(readonly conflict: BoxStoreCanonicalWriteConflictError) { super(conflict.message); this.name = "ManifestRetryStoppedError"; } }
export interface ManifestStoreDependencies { objectStoreProvider: BoxObjectStoreProvider; resolveStoreId(): Promise<string>; manifestRetry: RetryPolicy; manifestV2: boolean; windowId?: string; hydrationHandoffMarkerPath?: string; onManifestWriteConflict?(info: Record<string, unknown>): void }
export interface ManifestSaveOptions { acceptMatchingCanonicalOnConflict?: boolean; isForced?: boolean; hydrationUpdate?: "mark-incomplete" | "promote-complete" | "reset-complete" | undefined; captureTrace?: StoreDbCaptureTrace | undefined }

export class BoxStoreManifestStore {
  private writeManifestV2: boolean;
  manifest: BoxManifestMap | undefined;
  private readonly manifestRevisions = new WeakMap<BoxManifestMap, BoxStoreManifestRevisionState>();
  private readonly manifestAncestorRefCounts = new WeakMap<BoxManifestMap, Map<string, number>>();
  fullyHydrated: boolean | undefined;
  hydrationManifestReadBlocked = false;
  manifestWriteBlock: Error | undefined;
  readonly uncommittedStoreDbEntries = new Map<string, BoxStoreManifestEntry>();
  private manifestWriteQueue: Promise<void> = Promise.resolve();
  private manifestLoadInFlight: Promise<BoxManifestMap> | undefined;
  constructor(readonly args: { deps: ManifestStoreDependencies; now: () => number; log: (message: string) => void; isDisposed: () => boolean }) { this.writeManifestV2 = args.deps.manifestV2; }
  get deps(): ManifestStoreDependencies { return this.args.deps; }
  get writeQueue(): Promise<void> { return this.manifestWriteQueue; }
  get isManifestV2Enabled(): boolean { return this.writeManifestV2; }
  enrollManifestV2(): void { this.writeManifestV2 = true; }
  objectStore(storeId: string) { return this.deps.objectStoreProvider.forStore(storeId); }
  configuredManifestVersion(): 1 | 2 { return this.writeManifestV2 ? BOX_STORE_MANIFEST_VERSION : BOX_STORE_LEGACY_MANIFEST_VERSION; }
  configuredEntry(entry: BoxStoreManifestEntry): BoxStoreManifestEntry | undefined { if (this.writeManifestV2) return entry; if (entry.kind === "symlink") return undefined; return { sha: entry.sha, size: entry.size }; }
  configuredEntries(entries: Record<string, BoxStoreManifestEntry>): Record<string, BoxStoreManifestEntry> { const configured: Record<string, BoxStoreManifestEntry> = {}; for (const [relPath, entry] of Object.entries(entries)) { const value = this.configuredEntry(entry); if (value != null) configured[relPath] = value; } return configured; }
  parseManifest(bytes: Uint8Array): DecodedManifest | null { const parsed = parseManifest(bytes, (error) => { if (error instanceof BoxStoreUnsupportedManifestVersionError || this.manifestWriteBlock == null) this.manifestWriteBlock = error; }); if (parsed?.version === BOX_STORE_MANIFEST_VERSION) this.writeManifestV2 = true; return parsed; }
  manifestRevisionState(manifest: BoxManifestMap): BoxStoreManifestRevisionState { let state = this.manifestRevisions.get(manifest); if (state == null) { state = new BoxStoreManifestRevisionState(); this.manifestRevisions.set(manifest, state); } return state; }
  initializeManifestRevision(manifest: BoxManifestMap, persisted?: { revision: number; fullyHydrated?: boolean | undefined }): void { this.manifestRevisions.set(manifest, new BoxStoreManifestRevisionState(persisted)); }
  private ancestorRefCounts(manifest: BoxManifestMap): Map<string, number> { let counts = this.manifestAncestorRefCounts.get(manifest); if (counts != null) return counts; counts = new Map(); for (const relPath of manifest.keys()) this.adjustAncestorRefCounts(counts, relPath, 1); this.manifestAncestorRefCounts.set(manifest, counts); return counts; }
  private adjustAncestorRefCounts(counts: Map<string, number>, relPath: string, delta: number): void { for (let separatorIndex = relPath.indexOf("/"); separatorIndex >= 0; separatorIndex = relPath.indexOf("/", separatorIndex + 1)) { const ancestor = relPath.slice(0, separatorIndex), next = (counts.get(ancestor) ?? 0) + delta; if (next === 0) counts.delete(ancestor); else counts.set(ancestor, next); } }
  private deleteManifestEntryWithIndex(manifest: BoxManifestMap, relPath: string, counts?: Map<string, number>): boolean { if (!manifest.delete(relPath)) return false; if (counts != null) this.adjustAncestorRefCounts(counts, relPath, -1); this.uncommittedStoreDbEntries.delete(relPath); this.manifestRevisionState(manifest).markChanged(); return true; }
  setManifestEntry(manifest: BoxManifestMap, relPath: string, entry: BoxStoreManifestEntry): boolean {
    const configured = this.configuredEntry(entry); if (configured == null) return this.deleteManifestEntryWithIndex(manifest, relPath, this.manifestAncestorRefCounts.get(manifest));
    const counts = this.ancestorRefCounts(manifest); let removedConflict = false;
    for (let separatorIndex = relPath.indexOf("/"); separatorIndex >= 0; separatorIndex = relPath.indexOf("/", separatorIndex + 1)) removedConflict = this.deleteManifestEntryWithIndex(manifest, relPath.slice(0, separatorIndex), counts) || removedConflict;
    if ((counts.get(relPath) ?? 0) > 0) for (const existingPath of manifest.keys()) if (existingPath.startsWith(`${relPath}/`)) removedConflict = this.deleteManifestEntryWithIndex(manifest, existingPath, counts) || removedConflict;
    const current = manifest.get(relPath); if (boxStoreManifestEntriesEqual(current, configured)) return removedConflict; manifest.set(relPath, configured); if (current == null) this.adjustAncestorRefCounts(counts, relPath, 1); this.manifestRevisionState(manifest).markChanged(); return true;
  }
  deleteManifestEntry(manifest: BoxManifestMap, relPath: string): boolean { return this.deleteManifestEntryWithIndex(manifest, relPath, this.manifestAncestorRefCounts.get(manifest)); }
  private elapsedDurationMs(startedAt: number): number { return Math.max(0, this.args.now() - startedAt); }
  private markStoreDbEntriesCommitted(entries: Record<string, BoxStoreManifestEntry>): void { for (const [relPath, pending] of this.uncommittedStoreDbEntries) if (boxStoreManifestEntriesEqual(entries[relPath], pending)) this.uncommittedStoreDbEntries.delete(relPath); }
  isLiveManifest(manifest: BoxManifestMap | null | undefined): boolean { return manifest != null && this.manifest === manifest; }
  isStoreDbSweepCommitted(manifest: BoxManifestMap | null | undefined, capturedThisSweep: Iterable<string>): boolean { if (!this.isLiveManifest(manifest)) return false; for (const relPath of capturedThisSweep) if (this.uncommittedStoreDbEntries.has(relPath)) return false; return true; }
  loadManifest(storeId: string): Promise<BoxManifestMap> {
    if (this.manifestWriteBlock != null) return Promise.reject(this.manifestWriteBlock); if (this.manifest != null) return Promise.resolve(this.manifest);
    this.manifestLoadInFlight ??= (async () => { try {
      const map = new Map<string, BoxStoreManifestEntry>(); let persisted: { revision: number; fullyHydrated?: boolean | undefined } | undefined;
      const hydrationHandoffPending = this.deps.hydrationHandoffMarkerPath != null && existsSync(this.deps.hydrationHandoffMarkerPath);
      try { const bytes = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH); if (bytes == null && hydrationHandoffPending) throw new SandBoxStoreSyncError("manifest missing while legacy hydration handoff is pending");
        if (bytes != null) { const decoded = this.parseManifest(bytes); if (decoded == null && hydrationHandoffPending) throw new SandBoxStoreSyncError("manifest unreadable while legacy hydration handoff is pending"); if (decoded != null) { if (hydrationHandoffPending && decoded.fullyHydrated == null && this.deps.hydrationHandoffMarkerPath != null) await removeHydrationHandoffMarker(this.deps.hydrationHandoffMarkerPath); this.hydrationManifestReadBlocked = false; this.fullyHydrated = decoded.fullyHydrated; let isCanonicalSnapshot = true; for (const [relPath, entry] of Object.entries(decoded.entries)) { if (isHydrationHandoffManifestPath(relPath)) isCanonicalSnapshot = false; else map.set(relPath, entry); } if (isCanonicalSnapshot && decoded.version === this.configuredManifestVersion()) persisted = { revision: 0, fullyHydrated: decoded.fullyHydrated }; } }
      } catch (error) { if (error instanceof BoxStoreUnsupportedManifestVersionError || error instanceof BoxStoreManifestPathConflictError) throw error; if (hydrationHandoffPending) { this.hydrationManifestReadBlocked = true; throw error; } this.args.log(`manifest load failed, starting empty: ${errorMessage(error)}`); }
      this.initializeManifestRevision(map, persisted); this.manifest ??= map; return this.manifest;
    } finally { this.manifestLoadInFlight = undefined; } })();
    return this.manifestLoadInFlight;
  }
  saveManifest(storeId: string, options: ManifestSaveOptions = {}): Promise<void> {
    if (this.manifestWriteBlock != null) return Promise.reject(this.manifestWriteBlock); if (this.hydrationManifestReadBlocked) return Promise.reject(new Error("manifest write blocked until hydration metadata can be read"));
    const manifest = this.manifest ??= new Map(), revisionState = this.manifestRevisionState(manifest), isRequiredWrite = options.acceptMatchingCanonicalOnConflict === true || options.isForced === true || options.hydrationUpdate != null, captureTrace = options.captureTrace, queuedAt = captureTrace == null ? undefined : this.args.now(), capture = revisionState.capture(manifest, this.fullyHydrated, isRequiredWrite);
    if (capture == null) { if (!revisionState.hasPendingWriteForRevision) return Promise.resolve(); const settled = this.manifestWriteQueue; if (captureTrace == null || queuedAt == null) return settled; return settled.then(() => { captureTrace.queueDurationMs += this.elapsedDurationMs(queuedAt); }); }
    const run = async () => { if (captureTrace != null && queuedAt != null) captureTrace.queueDurationMs += this.elapsedDurationMs(queuedAt); const commitStartedAt = this.args.now(); try { if (this.manifestWriteBlock != null) throw this.manifestWriteBlock; let fullyHydrated = this.fullyHydrated; if (options.hydrationUpdate === "mark-incomplete") fullyHydrated = false; else if (options.hydrationUpdate === "promote-complete" || options.hydrationUpdate === "reset-complete") fullyHydrated = true; const entries = this.configuredEntries(capture.entries); await this.writeManifestWithRetry(storeId, entries, fullyHydrated, options); revisionState.markPersisted(capture, fullyHydrated); this.fullyHydrated = fullyHydrated; this.markStoreDbEntriesCommitted(entries); } catch (error) { revisionState.markFailed(); throw error; } finally { if (captureTrace != null) captureTrace.manifestCommitDurationMs += this.elapsedDurationMs(commitStartedAt); revisionState.release(capture); } };
    const save = this.manifestWriteQueue.then(run, run); this.manifestWriteQueue = save.then(() => {}, () => {}); return save;
  }
  private async writeManifestWithRetry(storeId: string, entries: Record<string, BoxStoreManifestEntry>, fullyHydrated: boolean | undefined, options: ManifestSaveOptions = {}): Promise<void> {
    let attempts = 0, lastConflict: BoxStoreCanonicalWriteConflictError | undefined;
    try { await this.deps.manifestRetry.runWithRetry(async (attempt) => { if (attempt > 1 && this.args.isDisposed() && lastConflict != null) throw new ManifestRetryStoppedError(lastConflict); attempts = attempt; const manifest = { version: this.configuredManifestVersion(), updatedAtMs: this.args.now(), writerWindowId: this.deps.windowId, fullyHydrated, entries }; try { await this.writeManifestAttempt(storeId, manifest); } catch (error) { if (error instanceof ManifestRetryStoppedError) lastConflict = error.conflict; else if (error instanceof BoxStoreCanonicalWriteConflictError) lastConflict = error; throw error; } }); return; }
    catch (error) { const conflict = error instanceof ManifestRetryStoppedError ? error.conflict : error; if (!(conflict instanceof BoxStoreCanonicalWriteConflictError)) throw error; if (await this.handleExhaustedManifestConflict(storeId, entries, fullyHydrated, conflict, attempts, options)) return; throw conflict; }
  }
  private async writeManifestAttempt(storeId: string, manifest: object): Promise<void> {
    try { await this.objectStore(storeId).put(BOX_STORE_MANIFEST_REL_PATH, new Uint8Array(Buffer.from(JSON.stringify(manifest), "utf8"))); }
    catch (error) { if (error instanceof BoxStoreCanonicalWriteConflictError && this.args.isDisposed()) throw new ManifestRetryStoppedError(error); if (error instanceof BoxStoreCanonicalWriteConflictError) { const canonical = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH); if (canonical != null) this.parseManifest(canonical); this.args.log(`manifest save lost a concurrent-write race; retry policy will use the winner's baseline${error.conflictRelPath == null ? "" : ` (lost attempt preserved at ${error.conflictRelPath})`}`); } throw error; }
  }
  private async handleExhaustedManifestConflict(storeId: string, entries: Record<string, BoxStoreManifestEntry>, fullyHydrated: boolean | undefined, conflict: BoxStoreCanonicalWriteConflictError, attempts: number, options: ManifestSaveOptions): Promise<boolean> {
    const canonical = await this.readCanonicalManifestForDiagnostics(storeId), attempted = Object.entries(entries), covered = canonical != null && attempted.length > 0 && attempted.every(([relPath, entry]) => boxStoreManifestEntriesEqual(canonical.entries[relPath], entry)), canonicalMatchesAttempt = covered && canonical != null && Object.keys(canonical.entries).length === attempted.length && canonical.fullyHydrated === fullyHydrated, live = this.manifest ?? new Map(), liveViewChanged = live.size !== attempted.length || attempted.some(([relPath, entry]) => !boxStoreManifestEntriesEqual(live.get(relPath), entry)), accepted = options.acceptMatchingCanonicalOnConflict === true && canonicalMatchesAttempt && !liveViewChanged;
    this.reportManifestWriteConflict({ storeId, attempts, accepted, covered, canonicalMatchesAttempt, liveViewChanged, attemptedEntries: attempted.length, lastBaseEtag: conflict.baseEtag, lastBaselineSource: conflict.baselineSource, lastConflictRelPath: conflict.conflictRelPath, canonicalReadable: canonical != null, canonicalEntryCount: canonical == null ? null : Object.keys(canonical.entries).length, canonicalUpdatedAtMs: canonical?.updatedAtMs ?? null, canonicalWriterWindowId: canonical?.writerWindowId ?? null, ourWindowId: this.deps.windowId ?? null });
    if (accepted) this.args.log(`manifest save lost a concurrent-write race; canonical manifest already covers the attempted entries (winner ${canonical?.writerWindowId ?? "unknown"}${conflict.conflictRelPath == null ? "" : `; lost attempt preserved at ${conflict.conflictRelPath}`})`);
    return accepted;
  }
  private async readCanonicalManifestForDiagnostics(storeId: string): Promise<{ entries: Record<string, BoxStoreManifestEntry>; updatedAtMs: number; writerWindowId: string | null; fullyHydrated?: boolean | undefined } | null> { try { const bytes = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH); if (bytes == null) return null; const parsed = parseManifest(bytes); if (parsed == null) return null; return { entries: parsed.entries, updatedAtMs: parsed.updatedAtMs, writerWindowId: parsed.writerWindowId ?? null, fullyHydrated: parsed.fullyHydrated }; } catch (error) { this.args.log(`canonical manifest readback failed after a lost write: ${errorMessage(error)}`); return null; } }
  async readCanonicalManifestSnapshot(): Promise<DecodedManifest | null> { const storeId = await this.deps.resolveStoreId(), bytes = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH); return bytes == null ? null : this.parseManifest(bytes); }
  private reportManifestWriteConflict(info: Record<string, unknown>): void { try { this.deps.onManifestWriteConflict?.(info); } catch {} }
  async prepareCanonicalManifestReset(storeId: string): Promise<void> { const bytes = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH); if (bytes == null) return; try { this.parseManifest(bytes); } catch (error) { if (!(error instanceof BoxStoreManifestPathConflictError)) throw error; if (this.manifestWriteBlock instanceof BoxStoreUnsupportedManifestVersionError) throw this.manifestWriteBlock; } if (this.manifestWriteBlock instanceof BoxStoreManifestPathConflictError) this.manifestWriteBlock = undefined; }
  async readManifestStrict(): Promise<BoxManifestMap> { return (await this.readManifestStrictDetailed()).manifest; }
  async readManifestStrictDetailed(): Promise<{ present: boolean; manifest: BoxManifestMap; fullyHydrated?: boolean | undefined }> { if (this.manifestWriteBlock != null) throw this.manifestWriteBlock; const storeId = await this.deps.resolveStoreId(), bytes = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH), map = new Map<string, BoxStoreManifestEntry>(); if (bytes == null) { this.initializeManifestRevision(map); this.manifest = map; this.uncommittedStoreDbEntries.clear(); this.fullyHydrated = undefined; this.hydrationManifestReadBlocked = false; return { present: false, manifest: map }; } const decoded = this.parseManifest(bytes); if (decoded == null) throw new SandBoxStoreSyncError("box store manifest is present but unparseable"); for (const [relPath, entry] of Object.entries(decoded.entries)) map.set(relPath, entry); this.initializeManifestRevision(map, decoded.version === this.configuredManifestVersion() ? { revision: 0, fullyHydrated: decoded.fullyHydrated } : undefined); this.manifest = map; this.uncommittedStoreDbEntries.clear(); this.fullyHydrated = decoded.fullyHydrated; this.hydrationManifestReadBlocked = false; return { present: true, manifest: map, fullyHydrated: decoded.fullyHydrated }; }
  async markLegacyHydrationIncomplete(): Promise<void> { const storeId = await this.deps.resolveStoreId(); if (this.deps.hydrationHandoffMarkerPath != null) await removeHydrationHandoffMarker(this.deps.hydrationHandoffMarkerPath); this.hydrationManifestReadBlocked = false; await this.loadManifest(storeId); await this.saveManifest(storeId, { hydrationUpdate: "mark-incomplete" }); }
  async markLegacyHydrationCompleteForHandoff(): Promise<void> { const markerPath = this.deps.hydrationHandoffMarkerPath; invariant(markerPath != null, "hydration handoff marker path is not configured"); await writeHydrationHandoffMarker(markerPath); }
}
