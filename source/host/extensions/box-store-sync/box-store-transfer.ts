import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, open, readlink, readdir, statfs, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { forEachBounded } from "../../box/box-transfer.js";
import { sha256Hex } from "../../sha256.js";
import { SQLITE_DB_SIDECAR_SUFFIXES } from "../../storage/store-db.js";
import { errorMessage } from "../../../shared/errors.js";
import { findSystemErrno } from "../../../shared/system-errno.js";
import { BOX_STORE_BLOBS_PREFIX, isBoxStoreManifestFileEntry, type BoxStoreManifestEntry } from "./box-store-manifest-format.js";
import { AGENT_STORE_DB_BASENAMES, type BoxManifestMap, type BoxStoreManifestStore } from "./box-store-manifest.js";
import type { BoxObjectStore, BoxObjectStoreProvider } from "./box-object-store.js";
import { BOX_STORE_RESTORE_TMP_SUFFIX, BoxStoreDownload, copyFileHashing, LARGE_OBJECT_FREE_SPACE_FACTOR, sha256File, type BoxStoreDownloadOptions, type BoxStoreDownloadSummary } from "./box-store-download.js";
import { BoxStorePackPipeline, type BoxStorePackCycleSummary } from "./box-store-pack-pipeline.js";
import { SandBoxStoreSyncError } from "./box-store-sync-error.js";
import type { WorkspaceIgnore } from "./workspace-ignore.js";

export const SNAPSHOT_OUT_LARGE_CONCURRENCY = 2;
export const BOX_STORE_SNAPSHOT_TMP_SUFFIX = ".box-store-snap-";
export async function readFreeDiskBytes(path: string): Promise<number | undefined> { let current = path; for (;;) { try { const stats = await statfs(current); return Number(stats.bavail) * Number(stats.bsize); } catch { const parent = dirname(current); if (parent === current) return undefined; current = parent; } } }
export function globToRegExp(glob: string): RegExp { const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&"), body = escaped.replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*"); return new RegExp(`^${body}(?:/.*)?$`); }

export type FileOutcome = "uploaded" | "unchanged" | "oversize" | "metadata-error" | "error";
export interface TransferSummary { filesUploaded: number; bytesUploaded: number; skippedUnchanged: number; oversize: number; failures: number; metadataFailures: number }
export interface CategoryTransferSummary extends TransferSummary { name: string; filesScanned: number; removed: number; excludedFiles?: number; excludedBytes?: number; prunedDirs?: number }
export interface BoxStoreStagedFiles { files: readonly { absPath: string; relPath: string; mode?: number }[]; skipped: number; cleanup(): Promise<void> }
export interface BoxStoreTransferCategory { name: string; absRoot: string; relPrefix: string; stageOnly?: boolean; idleOnly?: boolean; containsAgentStoreDbs?: boolean; excludes?: readonly string[]; ignore?(): WorkspaceIgnore; stage?(): Promise<BoxStoreStagedFiles> }
export interface BoxStoreTransferDependencies { categories: readonly BoxStoreTransferCategory[]; objectStoreProvider: BoxObjectStoreProvider; resolveStoreId(): Promise<string>; readFreeDiskBytes?(path: string): Promise<number | undefined>; hydrationHandoffMarkerPath?: string }
export function tallyFileOutcome(summary: TransferSummary, outcome: FileOutcome, size: number): void { if (outcome === "uploaded") { summary.filesUploaded += 1; summary.bytesUploaded += size; } else if (outcome === "unchanged") summary.skippedUnchanged += 1; else if (outcome === "oversize") summary.oversize += 1; else { summary.failures += 1; if (outcome === "metadata-error") summary.metadataFailures += 1; } }
export function tallyMetadataFailure(summary: TransferSummary): void { summary.failures += 1; summary.metadataFailures += 1; }
export function isSnapshotNodeRace(error: unknown): boolean { const errno = findSystemErrno(error); return errno === "ENOENT" || errno === "ELOOP" || error instanceof SandBoxStoreSyncError; }
export function classifyFileFailure(existing: BoxStoreManifestEntry | undefined, mode: number, fallback: "oversize" | "error"): FileOutcome { return existing != null && (existing.kind === "symlink" || existing.kind === "file" && existing.mode !== mode) ? "metadata-error" : fallback; }

interface FileStat { mtimeMs: number; size: number; mode: number }
interface Candidate { relPath: string; absPath: string; fileStat: FileStat; nodeKind: "file" | "symlink"; modeOverride?: number | undefined; bypassStatCache?: boolean }

export class BoxStoreTransfer {
  private readonly deps: BoxStoreTransferDependencies;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly manifestStore: BoxStoreManifestStore;
  private readonly maxObjectBytes: number;
  private readonly readFreeDiskBytes: (path: string) => Promise<number | undefined>;
  private readonly uploadConcurrency: number;
  private readonly largeObjectThreshold: number;
  readonly packPipeline: BoxStorePackPipeline;
  readonly downloader: BoxStoreDownload;
  readonly localStat = new Map<string, { mtimeMs: number; size: number; sha: string; mode: number }>();
  constructor(args: { deps: BoxStoreTransferDependencies; now: () => number; log: (message: string) => void; manifestStore: BoxStoreManifestStore; maxObjectBytes: number; downloadConcurrency: number; uploadConcurrency: number; largeObjectThreshold: number; downloadByteBudget: number; getFlushWaiters(): number }) {
    this.deps = args.deps;
    this.now = args.now;
    this.log = args.log;
    this.manifestStore = args.manifestStore;
    this.maxObjectBytes = args.maxObjectBytes;
    this.readFreeDiskBytes = args.deps.readFreeDiskBytes ?? readFreeDiskBytes;
    this.uploadConcurrency = args.uploadConcurrency;
    this.largeObjectThreshold = args.largeObjectThreshold;
    this.packPipeline = new BoxStorePackPipeline({ categories: args.deps.categories, objectStore: (storeId) => this.objectStore(storeId), manifestStore: args.manifestStore, now: args.now, log: args.log, getFlushWaiters: args.getFlushWaiters, discardTemp: (temp) => this.discardTemp(temp), sha256File });
    this.downloader = new BoxStoreDownload({ resolveStoreId: args.deps.resolveStoreId, objectStore: (storeId) => this.objectStore(storeId), manifestStore: args.manifestStore, log: args.log, downloadConcurrency: args.downloadConcurrency, largeObjectThreshold: args.largeObjectThreshold, downloadByteBudget: args.downloadByteBudget, hasDiskSpaceForLargeObject: (path, bytes) => this.hasDiskSpaceForLargeObject(path, bytes), discardTemp: (temp) => this.discardTemp(temp), packPipeline: this.packPipeline });
  }
  objectStore(storeId: string): BoxObjectStore { return this.deps.objectStoreProvider.forStore(storeId); }
  async discardTemp(args: { tmpPath: string; label: string }): Promise<void> { try { await unlink(args.tmpPath); } catch (error) { if (findSystemErrno(error) === "ENOENT") return; this.log(`temp cleanup failed ${args.label}: ${errorMessage(error)}`); } }
  async hasDiskSpaceForLargeObject(path: string, objectBytes: number): Promise<boolean> { const freeBytes = await this.readFreeDiskBytes(dirname(path)); return freeBytes === undefined || freeBytes >= objectBytes * LARGE_OBJECT_FREE_SPACE_FACTOR; }
  async syncFile(storeId: string, manifest: BoxManifestMap, relPath: string, absPath: string, fileStat: FileStat, bypassStatCache = false, modeOverride?: number): Promise<FileOutcome> {
    const existing = manifest.get(relPath); let mode = (modeOverride ?? fileStat.mode) & 0o777;
    if (fileStat.size > this.maxObjectBytes) { this.log(`oversize ${relPath}: ${fileStat.size}B over ${this.maxObjectBytes}B`); return classifyFileFailure(existing, mode, "oversize"); }
    const cached = this.localStat.get(relPath);
    if (!bypassStatCache && cached != null && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size && existing != null && isBoxStoreManifestFileEntry(existing) && existing.sha === cached.sha && existing.size === cached.size) { this.localStat.set(relPath, { ...cached, mode }); this.manifestStore.setManifestEntry(manifest, relPath, { kind: "file", sha: cached.sha, size: cached.size, mode }); return "unchanged"; }
    if (fileStat.size >= this.largeObjectThreshold) return this.syncLargeFile(storeId, manifest, relPath, absPath, fileStat.size, mode, modeOverride);
    let bytes: Uint8Array, effectiveStat = fileStat;
    try { const handle = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW); try { const live = await handle.stat(); if (!live.isFile()) throw new SandBoxStoreSyncError("snapshot source is not a regular file"); mode = (modeOverride ?? live.mode) & 0o777; effectiveStat = { mtimeMs: live.mtimeMs, size: live.size, mode }; bytes = await handle.readFile(); } finally { await handle.close(); } }
    catch (error) { this.log(`read failed ${relPath}: ${errorMessage(error)}`); return isSnapshotNodeRace(error) ? "metadata-error" : classifyFileFailure(existing, mode, "error"); }
    const sha = sha256Hex(bytes); this.localStat.set(relPath, { mtimeMs: effectiveStat.mtimeMs, size: bytes.byteLength, sha, mode });
    if (existing != null && isBoxStoreManifestFileEntry(existing) && existing.sha === sha && existing.size === bytes.byteLength) { this.manifestStore.setManifestEntry(manifest, relPath, { kind: "file", sha, size: bytes.byteLength, mode }); return "unchanged"; }
    try { await this.objectStore(storeId).put(`${BOX_STORE_BLOBS_PREFIX}/${sha}`, bytes, { contentAddressed: true }); } catch (error) { this.log(`upload failed ${relPath}: ${errorMessage(error)}`); return classifyFileFailure(existing, mode, "error"); }
    this.manifestStore.setManifestEntry(manifest, relPath, { kind: "file", sha, size: bytes.byteLength, mode }); return "uploaded";
  }
  private async syncLargeFile(storeId: string, manifest: BoxManifestMap, relPath: string, absPath: string, expectedSizeBytes: number, expectedMode: number, modeOverride?: number): Promise<FileOutcome> {
    const existing = manifest.get(relPath);
    if (existing != null && isBoxStoreManifestFileEntry(existing) && existing.mode !== expectedMode) { const [matchResult] = await Promise.allSettled([this.matchExistingLargeFile(absPath, existing, expectedMode, modeOverride != null)]); const matched = matchResult.status === "fulfilled" ? matchResult.value : undefined; if (matched != null) { this.localStat.set(relPath, matched); this.manifestStore.setManifestEntry(manifest, relPath, { kind: "file", sha: matched.sha, size: matched.size, mode: matched.mode }); return "unchanged"; } }
    if (!await this.hasDiskSpaceForLargeObject(absPath, expectedSizeBytes)) { this.log(`insufficient disk space for ${relPath} snapshot copy (${expectedSizeBytes}B needed x${LARGE_OBJECT_FREE_SPACE_FACTOR}); deferring to a later cycle`); return classifyFileFailure(existing, expectedMode, "error"); }
    const tmpPath = `${absPath}${BOX_STORE_SNAPSHOT_TMP_SUFFIX}${randomBytes(8).toString("hex")}`; let sha: string, size: number, mode: number;
    try { const copied = await copyFileHashing(absPath, tmpPath); sha = copied.sha; size = copied.size; mode = (modeOverride ?? copied.mode) & 0o777; }
    catch (error) { await this.discardTemp({ tmpPath, label: relPath }); this.log(`read failed ${relPath}: ${errorMessage(error)}`); return isSnapshotNodeRace(error) ? "metadata-error" : classifyFileFailure(existing, expectedMode, "error"); }
    try { if (size > this.maxObjectBytes) { this.log(`oversize ${relPath}: ${size}B over ${this.maxObjectBytes}B`); return classifyFileFailure(existing, mode, "oversize"); } const alreadyStored = existing != null && isBoxStoreManifestFileEntry(existing) && existing.sha === sha && existing.size === size; if (!alreadyStored) await this.objectStore(storeId).putFromFile!(`${BOX_STORE_BLOBS_PREFIX}/${sha}`, tmpPath, sha, size); this.manifestStore.setManifestEntry(manifest, relPath, { kind: "file", sha, size, mode }); await this.rememberLargeLocalStat(relPath, absPath, sha, size, mode); return alreadyStored ? "unchanged" : "uploaded"; }
    catch (error) { this.log(`upload failed ${relPath}: ${errorMessage(error)}`); return classifyFileFailure(existing, mode, "error"); } finally { await this.discardTemp({ tmpPath, label: relPath }); }
  }
  private async matchExistingLargeFile(absPath: string, existing: Exclude<BoxStoreManifestEntry, { kind: "symlink" }>, expectedMode: number, hasModeOverride: boolean) { const before = await lstat(absPath, { bigint: true }); if (!before.isFile() || before.size !== BigInt(existing.size)) return undefined; const sha = await sha256File(absPath), after = await lstat(absPath, { bigint: true }), sourceMode = Number(after.mode) & 0o777; if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mode !== after.mode || sha !== existing.sha || !hasModeOverride && sourceMode !== expectedMode) return undefined; return { mtimeMs: Number(after.mtimeNs) / 1e6, size: existing.size, sha, mode: expectedMode }; }
  private async rememberLargeLocalStat(relPath: string, absPath: string, sha: string, size: number, mode: number): Promise<void> { try { const live = await lstat(absPath); if (live.isFile() && live.size === size && (live.mode & 0o777) === mode) { this.localStat.set(relPath, { mtimeMs: live.mtimeMs, size, sha, mode }); return; } } catch {} this.localStat.delete(relPath); }
  private async syncSymlink(args: { manifest: BoxManifestMap; relPath: string; absPath: string }): Promise<"uploaded" | "unchanged" | "metadata-error"> { try { const target = await readlink(args.absPath), changed = this.manifestStore.setManifestEntry(args.manifest, args.relPath, { kind: "symlink", target }); this.localStat.delete(args.relPath); return changed ? "uploaded" : "unchanged"; } catch (error) { this.log(`readlink failed ${args.relPath}: ${errorMessage(error)}`); return "metadata-error"; } }
  async syncCategory(storeId: string, category: BoxStoreTransferCategory): Promise<CategoryTransferSummary> {
    const summary: CategoryTransferSummary = { name: category.name, filesScanned: 0, filesUploaded: 0, bytesUploaded: 0, skippedUnchanged: 0, removed: 0, oversize: 0, failures: 0, metadataFailures: 0 }, treeExists = category.stageOnly || existsSync(category.absRoot); let staged: BoxStoreStagedFiles | undefined;
    if (category.stage != null && treeExists) try { staged = await category.stage(); } catch (error) { this.log(`stage ${category.name} failed: ${errorMessage(error)}`); }
    try { const excludes = (category.excludes ?? []).map(globToRegExp); if (category.containsAgentStoreDbs) for (const basename of AGENT_STORE_DB_BASENAMES) { for (const suffix of ["", ...SQLITE_DB_SIDECAR_SUFFIXES]) excludes.push(globToRegExp(`${category.relPrefix}/**/${basename}${suffix}`)); excludes.push(globToRegExp(`${category.relPrefix}/**/${basename}.corrupt-*`)); excludes.push(globToRegExp(`${category.relPrefix}/**/${basename}.replacement*`)); excludes.push(globToRegExp(`${category.relPrefix}/**/${basename}.pending`)); }
      const seen = new Set<string>(), manifest = await this.manifestStore.loadManifest(storeId), ignore = category.ignore?.(), candidates: Candidate[] = []; let walkComplete = true;
      if (!category.stageOnly && treeExists) { const shouldSkipDir = ignore == null ? undefined : (relDir: string) => { if (!ignore.canPruneDir(relDir)) return false; summary.prunedDirs = (summary.prunedDirs ?? 0) + 1; return true; }; for await (const node of walkNodes(category.absRoot, shouldSkipDir)) { if (node.kind === "readdir-error") { walkComplete = false; tallyMetadataFailure(summary); continue; } const absPath = node.absPath, markerPath = this.deps.hydrationHandoffMarkerPath; if (markerPath != null && (absPath === markerPath || absPath.startsWith(`${markerPath}.`) && absPath.endsWith(".tmp"))) continue; const relUnderRoot = relative(category.absRoot, absPath).split(sep).join("/"), relPath = `${category.relPrefix}/${relUnderRoot}`; if (excludes.some((regex) => regex.test(relPath)) || relPath.includes(BOX_STORE_SNAPSHOT_TMP_SUFFIX) || relPath.includes(BOX_STORE_RESTORE_TMP_SUFFIX)) continue; let fileStat; try { fileStat = await lstat(absPath); } catch { seen.add(relPath); tallyMetadataFailure(summary); continue; } if (!fileStat.isFile() && !fileStat.isSymbolicLink()) { seen.add(relPath); tallyMetadataFailure(summary); continue; } if (ignore?.ignores(relUnderRoot)) { summary.excludedFiles = (summary.excludedFiles ?? 0) + 1; summary.excludedBytes = (summary.excludedBytes ?? 0) + fileStat.size; continue; } seen.add(relPath); candidates.push({ relPath, absPath, fileStat, nodeKind: fileStat.isSymbolicLink() ? "symlink" : "file" }); } }
      if (ignore != null && ((summary.prunedDirs ?? 0) > 0 || (summary.excludedFiles ?? 0) > 0)) this.log(`${category.name} ignore: pruned ${summary.prunedDirs ?? 0} dirs, excluded ${summary.excludedFiles ?? 0} files (${summary.excludedBytes ?? 0}B)`);
      for (const file of staged?.files ?? []) { let fileStat; try { fileStat = await lstat(file.absPath); } catch { tallyMetadataFailure(summary); continue; } if (!fileStat.isFile()) { tallyMetadataFailure(summary); continue; } seen.add(file.relPath); candidates.push({ relPath: file.relPath, absPath: file.absPath, fileStat, nodeKind: "file", modeOverride: file.mode, bypassStatCache: true }); }
      await this.uploadCandidates(storeId, manifest, candidates, summary); summary.failures += staged?.skipped ?? 0;
      if (!category.stageOnly && walkComplete) for (const relPath of [...manifest.keys()]) { if (!relPath.startsWith(`${category.relPrefix}/`) || excludes.some((regex) => regex.test(relPath)) || seen.has(relPath)) continue; this.manifestStore.deleteManifestEntry(manifest, relPath); this.localStat.delete(relPath); summary.removed += 1; }
      return summary;
    } finally { await staged?.cleanup().catch((error) => { this.log(`stage cleanup ${category.name} failed: ${errorMessage(error)}`); }); }
  }
  private async uploadCandidates(storeId: string, manifest: BoxManifestMap, candidates: readonly Candidate[], summary: CategoryTransferSummary): Promise<void> { const small: Candidate[] = [], large: Candidate[] = []; for (const candidate of candidates) (candidate.nodeKind === "file" && candidate.fileStat.size >= this.largeObjectThreshold ? large : small).push(candidate); const upload = async (candidate: Candidate) => { let fileStat; try { fileStat = await lstat(candidate.absPath); } catch { tallyMetadataFailure(summary); return; } summary.filesScanned += 1; if (fileStat.isSymbolicLink()) { tallyFileOutcome(summary, await this.syncSymlink({ manifest, relPath: candidate.relPath, absPath: candidate.absPath }), 0); return; } if (!fileStat.isFile()) { tallyMetadataFailure(summary); return; } const outcome = await this.syncFile(storeId, manifest, candidate.relPath, candidate.absPath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, mode: fileStat.mode }, candidate.bypassStatCache === true, candidate.modeOverride); tallyFileOutcome(summary, outcome, fileStat.size); }; await forEachBounded(small, this.uploadConcurrency, upload); await forEachBounded(large, SNAPSHOT_OUT_LARGE_CONCURRENCY, upload); }
  async syncPacks(storeId: string): Promise<BoxStorePackCycleSummary> { return this.packPipeline.syncPacks(storeId); }
  async download(targetDir: string, options: BoxStoreDownloadOptions = {}): Promise<BoxStoreDownloadSummary> { return this.downloader.download(targetDir, options); }
  async sweepLeakedTemps(): Promise<number> { const roots = dedupeNestedRoots(this.deps.categories.filter((category) => !category.stageOnly).map((category) => category.absRoot)); let removed = 0; for (const root of roots) for await (const node of walkNodes(root)) { if (node.kind !== "file" || !node.absPath.includes(BOX_STORE_SNAPSHOT_TMP_SUFFIX) && !node.absPath.includes(BOX_STORE_RESTORE_TMP_SUFFIX)) continue; try { await unlink(node.absPath); removed += 1; } catch {} } return removed; }
}

export async function* walkNodes(root: string, shouldSkipDir?: (relDir: string) => boolean): AsyncGenerator<{ kind: "file" | "symlink"; absPath: string } | { kind: "readdir-error" }> { async function* walk(dir: string): AsyncGenerator<{ kind: "file" | "symlink"; absPath: string } | { kind: "readdir-error" }> { let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { yield { kind: "readdir-error" }; return; } for (const entry of entries) { const abs = join(dir, entry.name); if (entry.isSymbolicLink()) yield { absPath: abs, kind: "symlink" }; else if (entry.isDirectory()) { if (shouldSkipDir != null) { const relDir = relative(root, abs).split(sep).join("/"); if (shouldSkipDir(relDir)) continue; } yield* walk(abs); } else if (entry.isFile()) yield { absPath: abs, kind: "file" }; } } yield* walk(root); }
export function dedupeNestedRoots(roots: readonly string[]): string[] { const unique = [...new Set(roots)]; return unique.filter((root) => !unique.some((other) => other !== root && root.startsWith(`${other}/`))); }
