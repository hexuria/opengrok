import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DebouncePolicy } from "../../../internal/scheduling.js";
import { MEMORY_PROFILE_PROMPT_LIMIT, formatMemoryDate, memoryDedupeKey, normalizeMemoryContent } from "../../runner/sand-memory.js";
import { WatchedDirectory } from "../../watched-directory.js";
import type { AgentProjectMembership } from "./project-membership.js";

export const MEMORY_DIRNAME = "memory";
export const PROFILE_FILENAME = "profile.md";
export const LOG_DIRNAME = "log";
export const MEMORY_SYNTHESIS_INPUT_LIMIT = 512;
export const MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MEMORY_CHANGE_DEBOUNCE_MS = 50;
const METADATA_DIRNAME = ".dreaming";
const PROFILE_HEADER = "# About the user\n\n<!-- Enduring facts, one per line as \"- (YYYY-MM-DD) <fact>\". -->\n\n";
const LOG_HEADER = "# Memory log\n\n<!-- Dated facts, one per line as \"- (YYYY-MM-DD) <fact>\". -->\n\n";
const FACT_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/;

export type MemoryKind = "profile" | "log";
export type MemoryOrigin = "explicit" | "synthesis" | "legacy";
export interface MemoryRecord { id: string; content: string; createdAt: number; kind: MemoryKind }
interface MemoryFact extends MemoryRecord { origin: MemoryOrigin; path: string; line: number; order: number }
export type SynthesisChange =
  | { action: "create"; content: string; kind: MemoryKind }
  | { action: "update"; id: string; content: string; kind: MemoryKind }
  | { action: "remove"; id: string };
export interface SynthesisSnapshot { fingerprint: string; memories: Array<MemoryRecord & { origin: MemoryOrigin }> }
export interface DreamingBridge { isEnabled(): boolean; record(evidence: unknown): void }

export function getAgentMemoryDir(agentDir: string): string { return join(agentDir, MEMORY_DIRNAME); }
export function memoryIdFor(content: string): string { return createHash("sha1").update(memoryDedupeKey(content)).digest("hex").slice(0, 16); }
export function serializeFactLine(content: string, createdAt: number): string { return `- (${formatMemoryDate(createdAt)}) ${content}`; }
export function parseFacts(raw: string, kind: MemoryKind, path = "", base = 0): MemoryFact[] {
  const facts: MemoryFact[] = [];
  for (const [line, text] of raw.split("\n").entries()) {
    const match = FACT_LINE.exec(text); if (match == null) continue;
    const content = normalizeMemoryContent(match[2] ?? ""); if (!content) continue;
    const createdAt = Date.parse(`${match[1]}T00:00:00Z`);
    facts.push({ id: memoryIdFor(content), content, createdAt: Number.isFinite(createdAt) ? createdAt : 0, kind, origin: "legacy", path, line, order: base + facts.length });
  }
  return facts;
}
export function agentMemoryHasContent(agentDir: string): boolean {
  const memoryDir = getAgentMemoryDir(agentDir), logDir = join(memoryDir, LOG_DIRNAME);
  let logs: string[] = []; try { logs = readdirSync(logDir).filter((name) => name.endsWith(".md")).map((name) => join(logDir, name)); } catch {}
  return [join(memoryDir, PROFILE_FILENAME), ...logs].some((path) => { try { return parseFacts(readFileSync(path, "utf8"), path.endsWith(PROFILE_FILENAME) ? "profile" : "log").length > 0; } catch { return false; } });
}

export class FileMemoryStore {
  readonly dir: WatchedDirectory;
  readonly profileFile: string;
  readonly logDir: string;
  readonly explicitDir: string;
  readonly generatedDir: string;
  readonly tombstoneDir: string;
  readonly refreshFile: string;
  constructor(readonly memoryDir: string, debounce: DebouncePolicy, readonly dreaming?: DreamingBridge) {
    this.dir = new WatchedDirectory(memoryDir, debounce);
    this.profileFile = join(memoryDir, PROFILE_FILENAME);
    this.logDir = join(memoryDir, LOG_DIRNAME);
    const metadata = join(memoryDir, METADATA_DIRNAME);
    this.explicitDir = join(metadata, "explicit"); this.generatedDir = join(metadata, "synthesized"); this.tombstoneDir = join(metadata, "tombstones"); this.refreshFile = join(metadata, "next-refresh-at");
  }
  get recordMemoryEvidence(): ((evidence: unknown) => void) | undefined { return this.dreaming?.isEnabled() === true ? (evidence) => this.dreaming?.record(evidence) : undefined; }
  getLocation(): string { return this.dir.getLocation(); }
  setOnChange(listener?: (() => void) | null): void { this.dir.setOnChange(listener); }
  private read(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }
  private logFiles(): string[] { try { return readdirSync(this.logDir).filter((name) => name.endsWith(".md")).sort().map((name) => join(this.logDir, name)); } catch { return []; } }
  private logFileForDate(createdAt: number): string { return join(this.logDir, `${formatMemoryDate(createdAt).slice(0, 7)}.md`); }
  private originPath(content: string, origin: Exclude<MemoryOrigin, "legacy">): string { return join(origin === "explicit" ? this.explicitDir : this.generatedDir, `${memoryIdFor(content)}.memory`); }
  private tombstonePath(content: string): string { return join(this.tombstoneDir, `${memoryIdFor(content)}.deleted`); }
  private hasFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
  private memoryOrigin(content: string): MemoryOrigin { if (this.hasFile(this.originPath(content, "explicit"))) return "explicit"; if (this.hasFile(this.originPath(content, "synthesis"))) return "synthesis"; return "legacy"; }
  private markOrigin(content: string, origin: Exclude<MemoryOrigin, "legacy">): void { this.dir.writeFileAtomic(this.originPath(content, origin), ""); }
  private clearOrigins(content: string): void { rmSync(this.originPath(content, "explicit"), { force: true }); rmSync(this.originPath(content, "synthesis"), { force: true }); }
  private isTombstoned(content: string): boolean { return this.hasFile(this.tombstonePath(content)); }
  private markTombstone(content: string): void { this.dir.writeFileAtomic(this.tombstonePath(content), ""); }
  private clearTombstone(content: string): void { rmSync(this.tombstonePath(content), { force: true }); }
  private facts(): MemoryFact[] {
    const profile = parseFacts(this.read(this.profileFile), "profile", this.profileFile);
    const logs: MemoryFact[] = []; for (const path of this.logFiles()) logs.push(...parseFacts(this.read(path), "log", path, logs.length));
    return [...profile, ...logs].map((fact) => ({ ...fact, origin: this.memoryOrigin(fact.content) }));
  }
  private record(fact: MemoryFact): MemoryRecord { return { id: fact.id, content: fact.content, createdAt: fact.createdAt, kind: fact.kind }; }
  private byRecent(a: MemoryFact, b: MemoryFact): number { return b.createdAt - a.createdAt || b.order - a.order; }
  recall(recentLimit = 20): { profile: MemoryRecord[]; recent: MemoryRecord[] } { const facts = this.facts(); return { profile: facts.filter((fact) => fact.kind === "profile").sort((a, b) => this.byRecent(a, b)).slice(0, MEMORY_PROFILE_PROMPT_LIMIT).map((fact) => this.record(fact)), recent: facts.filter((fact) => fact.kind === "log").sort((a, b) => this.byRecent(a, b)).slice(0, Math.max(0, Math.floor(recentLimit))).map((fact) => this.record(fact)) }; }
  listMemories(limit = 100): MemoryRecord[] { return this.facts().sort((a, b) => Number(b.kind === "profile") - Number(a.kind === "profile") || this.byRecent(a, b)).slice(0, Math.max(0, Math.floor(limit))).map((fact) => this.record(fact)); }
  countMemories(): number { return this.facts().length; }
  addMemory(content: string, createdAt: number, kind: MemoryKind): MemoryRecord | null {
    const normalized = normalizeMemoryContent(content); if (!normalized) return null;
    const existing = this.facts().find((fact) => memoryDedupeKey(fact.content) === memoryDedupeKey(normalized));
    if (existing != null) { if (this.dreaming?.isEnabled()) { this.clearTombstone(existing.content); this.clearOrigins(existing.content); this.markOrigin(existing.content, "explicit"); } return null; }
    const path = kind === "profile" ? this.profileFile : this.logFileForDate(createdAt), raw = this.read(path), base = raw || (kind === "profile" ? PROFILE_HEADER : LOG_HEADER);
    this.dir.writeFileAtomic(path, `${base}${base.endsWith("\n") ? "" : "\n"}${serializeFactLine(normalized, createdAt)}\n`);
    if (this.dreaming?.isEnabled()) { this.clearTombstone(normalized); this.clearOrigins(normalized); this.markOrigin(normalized, "explicit"); }
    return { id: memoryIdFor(normalized), content: normalized, createdAt, kind };
  }
  removeMemoryByContent(content: string): boolean { const normalized = normalizeMemoryContent(content); return normalized ? this.removeMemory(memoryIdFor(normalized)) : false; }
  removeMemory(id: string): boolean {
    for (const fact of this.facts()) {
      if (fact.id !== id) continue; const raw = this.read(fact.path), lines = raw.split("\n"); lines.splice(fact.line, 1); this.dir.writeFileAtomic(fact.path, lines.join("\n"));
      if (this.dreaming?.isEnabled()) { this.clearOrigins(fact.content); this.markTombstone(fact.content); }
      return true;
    }
    return false;
  }
  prepareSynthesis(): SynthesisSnapshot {
    const state = this.readSynthesisState(), seen = new Set<string>();
    const memories = [...state.facts].sort((a, b) => Number(b.origin === "explicit") - Number(a.origin === "explicit") || Number(b.kind === "profile") - Number(a.kind === "profile") || this.byRecent(a, b)).filter((fact) => { if (seen.has(fact.id)) return false; seen.add(fact.id); return true; }).slice(0, MEMORY_SYNTHESIS_INPUT_LIMIT).map(({ id, content, createdAt, kind, origin }) => ({ id, content, createdAt, kind, origin }));
    return { fingerprint: state.fingerprint, memories };
  }
  applySynthesis(snapshot: SynthesisSnapshot, changes: readonly SynthesisChange[], now: number): "committed" | "stale" | "invalid" {
    const state = this.readSynthesisState(); if (state.fingerprint !== snapshot.fingerprint) return "stale";
    const allowed = new Set(snapshot.memories.map((memory) => memory.id)), byId = new Map(state.facts.map((fact) => [fact.id, fact])), changed = new Set<string>();
    for (const change of changes) {
      if (change.action === "create") { const content = normalizeMemoryContent(change.content); if (!content) return "invalid"; if (!this.isTombstoned(content)) this.addSynthesized(content, now, change.kind); continue; }
      if (!allowed.has(change.id) || changed.has(change.id)) return "invalid"; const current = byId.get(change.id); if (current == null || current.origin === "explicit") return "invalid"; changed.add(change.id);
      if (change.action === "remove") { this.removeFact(current, false); continue; }
      const content = normalizeMemoryContent(change.content); if (!content) return "invalid"; this.removeFact(current, false); if (!this.isTombstoned(content)) this.addSynthesized(content, now, change.kind);
    }
    this.markTemporalReview(now); return "committed";
  }
  private removeFact(fact: MemoryFact, tombstone: boolean): void { const lines = this.read(fact.path).split("\n"); lines.splice(fact.line, 1); this.dir.writeFileAtomic(fact.path, lines.join("\n")); this.clearOrigins(fact.content); if (tombstone) this.markTombstone(fact.content); }
  private addSynthesized(content: string, createdAt: number, kind: MemoryKind): void { if (this.facts().some((fact) => memoryDedupeKey(fact.content) === memoryDedupeKey(content))) return; const path = kind === "profile" ? this.profileFile : this.logFileForDate(createdAt), raw = this.read(path), base = raw || (kind === "profile" ? PROFILE_HEADER : LOG_HEADER); this.dir.writeFileAtomic(path, `${base}${base.endsWith("\n") ? "" : "\n"}${serializeFactLine(content, createdAt)}\n`); this.clearOrigins(content); this.markOrigin(content, "synthesis"); }
  hasMemories(): boolean { return this.countMemories() > 0; }
  isTemporalReviewDue(now: number): boolean { const next = Number.parseInt(this.read(this.refreshFile).trim(), 10); return !Number.isFinite(next) || next <= now; }
  markTemporalReview(now: number): void { this.dir.writeFileAtomic(this.refreshFile, `${now + MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS}\n`); }
  clearMemories(): void { const facts = this.facts(); if (!facts.length) return; if (this.dreaming?.isEnabled()) for (const fact of facts) { this.clearOrigins(fact.content); this.markTombstone(fact.content); } rmSync(this.logDir, { recursive: true, force: true }); this.dir.writeFileAtomic(this.profileFile, PROFILE_HEADER); }
  private readSynthesisState(): { fingerprint: string; facts: MemoryFact[] } { const files = [{ path: this.profileFile, raw: this.read(this.profileFile), kind: "profile" as const }, ...this.logFiles().map((path) => ({ path, raw: this.read(path), kind: "log" as const }))], hash = createHash("sha256"), facts: MemoryFact[] = []; for (const file of files) { hash.update(file.path).update("\0").update(file.raw).update("\0"); facts.push(...parseFacts(file.raw, file.kind, file.path, facts.length).map((fact) => ({ ...fact, origin: this.memoryOrigin(fact.content) }))); } return { fingerprint: hash.digest("hex"), facts }; }
}

export function getUserMemoryDir(sandRoot: string): string { return join(sandRoot, "user-memory"); }
export function getUserMemoryShardsDir(sandRoot: string): string { return join(getUserMemoryDir(sandRoot), "agents"); }
export function getUserMemoryShardDir(sandRoot: string, agentId: string): string { return join(getUserMemoryShardsDir(sandRoot), agentId); }
export function getProjectsRootDir(sandRoot: string): string { return join(sandRoot, "projects"); }
export function getProjectDir(sandRoot: string, slug: string): string { return join(getProjectsRootDir(sandRoot), slug); }
export function getProjectMemoryShardsDir(sandRoot: string, slug: string): string { return join(getProjectDir(sandRoot, slug), "memory", "agents"); }
export function getProjectMemoryShardDir(sandRoot: string, slug: string, agentId: string): string { return join(getProjectMemoryShardsDir(sandRoot, slug), agentId); }
export function projectDirExists(sandRoot: string, slug: string): boolean { try { return statSync(getProjectDir(sandRoot, slug)).isDirectory(); } catch { return false; } }

export class UserMemoryStore {
  constructor(readonly sandRoot: string, readonly ownAgentId: string, readonly resolveAgentName: (id: string) => string, readonly debounce: DebouncePolicy) {}
  getLocation(): string { return getUserMemoryDir(this.sandRoot); }
  getOwnShardLocation(): string { return getUserMemoryShardDir(this.sandRoot, this.ownAgentId); }
  recall(limits: { profile: number; recent: number } = { profile: 50, recent: 20 }) { const profile: Array<MemoryRecord & { agentId: string; agentName: string }> = [], recent: Array<MemoryRecord & { agentId: string; agentName: string }> = []; let ids: string[] = []; try { ids = readdirSync(getUserMemoryShardsDir(this.sandRoot)); } catch {} for (const id of ids) { const store = new FileMemoryStore(getUserMemoryShardDir(this.sandRoot, id), this.debounce), recalled = store.recall(limits.recent); profile.push(...recalled.profile.map((item) => ({ ...item, agentId: id, agentName: this.resolveAgentName(id) }))); recent.push(...recalled.recent.map((item) => ({ ...item, agentId: id, agentName: this.resolveAgentName(id) }))); } return { profile: profile.slice(0, limits.profile), recent: recent.sort((a, b) => b.createdAt - a.createdAt).slice(0, limits.recent) }; }
}
export class ProjectMemoryStore {
  constructor(readonly sandRoot: string, readonly ownAgentId: string, readonly membership: AgentProjectMembership, readonly resolveAgentName: (id: string) => string, readonly debounce: DebouncePolicy) {}
  getLocation(): string { return getProjectsRootDir(this.sandRoot); }
  recall(limits: { profile: number; recent: number } = { profile: 50, recent: 20 }, cap = 100) { const results: Array<{ project: string; agentId: string; agentName: string; memory: MemoryRecord }> = []; for (const slug of this.membership.read()) { let ids: string[] = []; try { ids = readdirSync(getProjectMemoryShardsDir(this.sandRoot, slug)); } catch {} for (const id of ids) { const store = new FileMemoryStore(getProjectMemoryShardDir(this.sandRoot, slug, id), this.debounce), recalled = store.recall(limits.recent); for (const memory of [...recalled.profile, ...recalled.recent]) results.push({ project: slug, agentId: id, agentName: this.resolveAgentName(id), memory }); } } return results.sort((a, b) => b.memory.createdAt - a.memory.createdAt).slice(0, cap); }
}

export class MemoryService {
  private activeAgentId: string | null = null;
  private readonly listeners = new Set<() => void>();
  private synthesis: { start(): void; dispose(): void; recordTurn?(agentId: string, exchange: unknown): void } | null = null;
  constructor(readonly options: { sandRoot?: string; agentsRootDir: string; debounce: DebouncePolicy }) {}
  createAgentStore(agentDir: string): FileMemoryStore { return new FileMemoryStore(getAgentMemoryDir(agentDir), this.options.debounce, { isEnabled: () => this.synthesis != null, record: (evidence) => { const id = basename(agentDir); this.synthesis?.recordTurn?.(id, evidence); } }); }
  agentHasContent(agentDir: string): boolean { return agentMemoryHasContent(agentDir); }
  enableMemorySynthesis(service: { start(): void; dispose(): void; recordTurn?(agentId: string, exchange: unknown): void }): void { this.synthesis?.dispose(); this.synthesis = service; service.start(); }
  list({ agentId }: { agentId: string }): MemoryRecord[] { return this.storeForAgent(agentId).listMemories(); }
  remove({ agentId, id }: { agentId: string; id: string }): boolean { const removed = this.storeForAgent(agentId).removeMemory(id); if (removed) this.emit(); return removed; }
  clear({ agentId }: { agentId: string }): void { this.storeForAgent(agentId).clearMemories(); this.emit(); }
  setActiveAgent(agentId: string | null): void { if (this.activeAgentId === agentId) return; this.activeAgentId = agentId; this.emit(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose(): void { this.synthesis?.dispose(); this.synthesis = null; this.listeners.clear(); }
  synthesisTargetForAgent(agentId: string): FileMemoryStore | null { const dir = join(this.options.agentsRootDir, agentId); return existsSync(dir) ? this.createAgentStore(dir) : null; }
  listSynthesisTargets(): Array<{ agentId: string; store: FileMemoryStore }> { let ids: string[] = []; try { ids = readdirSync(this.options.agentsRootDir); } catch {} return ids.flatMap((agentId) => { const store = this.synthesisTargetForAgent(agentId); return store == null ? [] : [{ agentId, store }]; }); }
  storeForAgent(agentId: string): FileMemoryStore { return this.createAgentStore(join(this.options.agentsRootDir, agentId)); }
  private emit(): void { for (const listener of [...this.listeners]) listener(); }
}
