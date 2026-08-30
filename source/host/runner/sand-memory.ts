export const MEMORY_RECENT_PROMPT_LIMIT = 30;
export const MEMORY_RECENT_PROMPT_CHAR_BUDGET = 4_000;
export const MEMORY_PROFILE_PROMPT_LIMIT = 100;
export const MEMORY_UI_LIMIT = 1_000;
export const MEMORY_MAX_CONTENT_LENGTH = 500;
export const MEMORY_EXTRACTION_PROMPT_MARKER = "<<SAND_MEMORY_EXTRACTION>>";
export const MEMORY_EPISODE_PROMPT_MARKER = "<<SAND_MEMORY_EPISODE>>";
export const MEMORY_EPISODE_PREFIX = "[episode] ";
export const MEMORY_NOTE_PREFIX = "[note] ";
export const MEMORY_EXTRACTION_NONE_SENTINEL = "NONE";
export const MEMORY_EXTRACTION_ARCHIVE_SCAN_LIMIT = 500;
export const DEFAULT_EPISODE_INTERVAL = 6;
export const MEMORY_USER_PROFILE_PROMPT_LIMIT = 50;
export const MEMORY_USER_RECENT_PROMPT_LIMIT = 15;
export const MEMORY_PROJECT_PROFILE_PROMPT_LIMIT = 25;
export const MEMORY_PROJECT_RECENT_PROMPT_LIMIT = 10;
export const MEMORY_PROJECT_INJECTED_CAP = 3;
export const MEMORY_DECAY_HALF_LIFE_DAYS = 30;
export const DAY_MS = 86_400_000;

export interface MemoryRecord { readonly id?: string; readonly content: string; readonly createdAt: number; readonly kind?: "profile" | "log" }
export interface MemoryRecall { readonly profile: readonly MemoryRecord[]; readonly recent: readonly MemoryRecord[] }
export interface MemoryExtraction { readonly additions: readonly { readonly content: string; readonly kind: "profile" | "log" }[]; readonly removals: readonly string[] }
export interface FrozenMemorySnapshot { readonly render: string; readonly compactionEpoch: number }

export function isMemoryFreezeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SAND_DISABLE_MEMORY_FREEZE !== "1";
}

export function resolveFrozenMemoryPrompt(args: {
  readonly snapshot?: FrozenMemorySnapshot;
  readonly compactionEpoch: number;
  readonly renderLive: () => { readonly render: string; readonly hasFacts: boolean };
}): { readonly render: string; readonly snapshotToPersist?: FrozenMemorySnapshot } {
  if (args.snapshot != null && args.snapshot.compactionEpoch === args.compactionEpoch) return { render: args.snapshot.render };
  const live = args.renderLive();
  return !live.hasFacts ? { render: live.render } : { render: live.render, snapshotToPersist: { render: live.render, compactionEpoch: args.compactionEpoch } };
}

export function getEpisodeInterval(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SAND_MEMORY_EPISODE_INTERVAL;
  if (raw == null) return DEFAULT_EPISODE_INTERVAL;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EPISODE_INTERVAL;
}

const TRIVIAL_EXCHANGES = new Set(["hi", "hey", "hello", "yo", "sup", "thanks", "thank you", "ty", "thx", "ok", "okay", "k", "kk", "cool", "nice", "great", "awesome", "perfect", "yes", "yep", "yeah", "no", "nope", "sure", "got it", "gotcha", "lol", "haha", "np", "done", "good", "bye"]);

export function isMemorableExchange(userMessage: string): boolean {
  const user = userMessage.trim();
  if (user.length === 0) return false;
  if (user.length > 40 || user.includes("?")) return true;
  return !TRIVIAL_EXCHANGES.has(user.toLowerCase().replace(/[\s!.…,~)\]]+$/g, "").replace(/\s+/g, " ").trim());
}

export function normalizeMemoryContent(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MEMORY_MAX_CONTENT_LENGTH);
}
export function memoryDedupeKey(content: string): string { return normalizeMemoryContent(content).toLowerCase(); }
export function memoryImportance(contentOrRecord: string | MemoryRecord): number {
  const content = typeof contentOrRecord === "string" ? contentOrRecord : contentOrRecord.content;
  return content.startsWith(MEMORY_EPISODE_PREFIX) ? 1.5 : content.startsWith(MEMORY_NOTE_PREFIX) ? 0.5 : 1;
}
export function memoryRecallRank(memory: MemoryRecord): number {
  return Math.log2(memoryImportance(memory.content)) + memory.createdAt / (MEMORY_DECAY_HALF_LIFE_DAYS * DAY_MS);
}
export function formatMemoryDate(createdAtMs: number): string {
  return !Number.isFinite(createdAtMs) || createdAtMs <= 0 ? "unknown date" : new Date(createdAtMs).toISOString().slice(0, 10);
}
export function factLine(memory: MemoryRecord): string { return `- (learned ${formatMemoryDate(memory.createdAt)}) ${memory.content}`; }

function toRecall(value: MemoryRecall | readonly MemoryRecord[]): MemoryRecall {
  return Array.isArray(value) ? { profile: value.filter((record) => record.kind === "profile"), recent: value.filter((record) => record.kind !== "profile") } : value as MemoryRecall;
}

export function renderMemorySystemPrompt(value: MemoryRecall | readonly MemoryRecord[], location?: string): string {
  const { profile, recent } = toRecall(value);
  if (profile.length === 0 && recent.length === 0 && location == null) return "";
  const lines = [
    "Memory: durable facts you have learned about the user and their world.",
    "These persist across every conversation with this agent, even after the chat is cleared. Rely on them so you stay consistent and avoid re-asking what you already know.",
  ];
  if (location != null) lines.push(
    `Your memory lives in a folder at ${location}: profile.md holds who the user is (kept in mind every turn) and log/ holds dated history.`,
    'Read or grep those files with Read and Shell on your own computer when you need older facts that are not listed here. To CHANGE memory, prefer the update_state tool (target "memory"): action "write" with a fact and a tier (profile | log | note), or action "forget" with the exact text of a recorded fact.',
  );
  if (profile.length > 0) lines.push("About the user:", ...profile.map(factLine));
  if (recent.length > 0) {
    lines.push("Recently:");
    let budget = MEMORY_RECENT_PROMPT_CHAR_BUDGET;
    let shown = 0;
    for (const memory of recent) {
      const line = factLine(memory);
      if (shown > 0 && line.length > budget) break;
      lines.push(line); budget -= line.length; shown += 1;
    }
    const omitted = recent.length - shown;
    if (omitted > 0) lines.push(location == null ? `(${omitted} more log facts not shown.)` : `(${omitted} more log facts on disk \u2014 grep the log/ folder for them.)`);
  }
  if (profile.length === 0 && recent.length === 0) lines.push("No facts recorded yet.");
  return lines.join("\n");
}

export function buildExtractionSystemPrompt(): string {
  return [
    MEMORY_EXTRACTION_PROMPT_MARKER,
    "You maintain the long-term memory of a personal assistant. Read the latest exchange and decide what \u2014 if anything \u2014 is worth remembering for future, unrelated conversations.",
    "",
    "Tag each fact you keep with a category:",
    '- "profile": enduring facts about who the user is and how to work with them \u2014 their name and how to address them, role, location, languages, lasting preferences and constraints, and important people or relationships. These are remembered indefinitely.',
    '- "log": substantive history worth keeping \u2014 ongoing projects and tasks, decisions, commitments, and time-bound details.',
    '- "note": minor, low-stakes details that might help someday but are not worth keeping in mind every turn (small one-off preferences, incidental context). Notes fade from the always-visible list fastest but stay on disk.',
    "",
    "Do NOT record one-off request mechanics, what the assistant did this turn, general knowledge, or anything already present in the existing memory list.",
    "",
    'If the new exchange updates or contradicts a fact in the existing memory list (e.g. the user moved, changed jobs, or renamed something), drop anything clearly superseded: output a line "remove: <the exact existing fact text>" and then add the corrected fact. Only remove facts that appear verbatim in the existing list \u2014 never invent removals.',
    "",
    `Write each fact as a self-contained statement, one per line: "profile: <fact>", "log: <fact>", or "note: <fact>" to add (e.g. "profile: The user's name is Ian", "log: Planning a trip to Tokyo in October 2025"), or "remove: <existing fact>" to drop a superseded one.`,
    `Output exactly ${MEMORY_EXTRACTION_NONE_SENTINEL} (and nothing else) when there is nothing to add or remove.`,
  ].join("\n");
}

export function buildExtractionUserPrompt(userMessage: string, agentMessage = "", existingMemories: readonly string[] = []): string {
  return ["Existing memory:", existingMemories.length > 0 ? existingMemories.map((memory) => `- ${memory}`).join("\n") : "(empty)", "", "Latest exchange:", `User: ${userMessage.trim() || "(no message)"}`, `Assistant: ${agentMessage.trim() || "(no message)"}`].join("\n");
}

const CATEGORY_LINE = /^(profile|log|note|remove)\s*:\s*(.+)$/i;
export function parseExtractedMemories(raw: string, existingMemories: readonly string[] = []): MemoryExtraction {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.toUpperCase() === MEMORY_EXTRACTION_NONE_SENTINEL) return { additions: [], removals: [] };
  const seen = new Set(existingMemories.map(memoryDedupeKey));
  const additions: Array<{ content: string; kind: "profile" | "log" }> = [];
  const removals: string[] = [];
  for (const rawLine of trimmed.split("\n")) {
    const stripped = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "");
    const category = CATEGORY_LINE.exec(stripped);
    const tag = category?.[1]?.toLowerCase();
    const bare = normalizeMemoryContent(category?.[2] ?? stripped);
    if (bare.length === 0 || bare.toUpperCase() === MEMORY_EXTRACTION_NONE_SENTINEL) continue;
    if (tag === "remove") { removals.push(bare); continue; }
    const content = tag === "note" ? normalizeMemoryContent(`${MEMORY_NOTE_PREFIX}${bare}`) : bare;
    const key = memoryDedupeKey(content);
    if (seen.has(key)) continue;
    seen.add(key); additions.push({ content, kind: tag === "profile" ? "profile" : "log" });
  }
  return { additions, removals };
}

const RELEVANCE_TOKEN = /[\p{L}\p{N}]{4,}/gu;
const RELEVANCE_STOPWORDS = new Set(["that", "this", "with", "from", "they", "them", "then", "than", "what", "when", "where", "which", "will", "would", "could", "should", "have", "been", "being", "about", "just", "like", "your", "does", "were", "also", "into", "over", "only", "some", "more", "most", "very", "much", "here", "there", "their", "these", "those", "because", "while", "after", "before", "user"]);
function relevanceTokens(text: string): Set<string> {
  const result = new Set<string>();
  for (const match of text.toLowerCase().matchAll(RELEVANCE_TOKEN)) if (!RELEVANCE_STOPWORDS.has(match[0])) result.add(match[0]);
  return result;
}

export function selectRelevantMemories(query: string, memories: readonly MemoryRecord[], max: number): MemoryRecord[];
export function selectRelevantMemories(memories: readonly MemoryRecord[], query: string, max: number): MemoryRecord[];
export function selectRelevantMemories(first: string | readonly MemoryRecord[], second: string | readonly MemoryRecord[], max: number): MemoryRecord[] {
  const query = typeof first === "string" ? first : second as string;
  const memories = typeof first === "string" ? second as readonly MemoryRecord[] : first;
  if (max <= 0 || memories.length === 0) return [];
  const queryTokens = relevanceTokens(query);
  if (queryTokens.size === 0) return [];
  return memories.map((memory) => ({ memory, overlap: [...relevanceTokens(memory.content)].filter((token) => queryTokens.has(token)).length }))
    .filter((entry) => entry.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap || right.memory.createdAt - left.memory.createdAt)
    .slice(0, max).map((entry) => entry.memory);
}

export function gatherExtractionMemories(recall: MemoryRecall, archive: readonly MemoryRecord[], exchangeText: string): string[] {
  const inPrompt = [...recall.profile, ...recall.recent];
  const seen = new Set(inPrompt.map((memory) => memoryDedupeKey(memory.content)));
  const candidates = archive.filter((memory) => !seen.has(memoryDedupeKey(memory.content)));
  return [...inPrompt, ...selectRelevantMemories(exchangeText, candidates, 10)].map((memory) => memory.content);
}

export interface TextExecutor {
  getMessages(): readonly unknown[];
  getState(): unknown;
  clearMessages(): void;
  appendMessages(messages: readonly { readonly role: "system" | "user"; readonly content: string }[]): void;
  stream(ctx: unknown, first?: unknown, second?: unknown, options?: object): { readonly fullStream: AsyncIterable<{ readonly type: string; readonly textDelta?: string; readonly error?: unknown }> };
}

export async function collectExecutorText(executor: TextExecutor, ctx: unknown): Promise<string> {
  let text = "";
  for await (const part of executor.stream(ctx, undefined, undefined, {}).fullStream) {
    if (part.type === "text-delta") text += part.textDelta ?? "";
    else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
  }
  return text;
}

export async function extractMemories(args: { executor: TextExecutor; ctx: unknown; userMessage: string; agentMessage: string; existingMemories: readonly string[] }): Promise<MemoryExtraction>;
export async function extractMemories(text: string, execute: (system: string, user: string) => Promise<string>): Promise<MemoryExtraction>;
export async function extractMemories(first: string | { executor: TextExecutor; ctx: unknown; userMessage: string; agentMessage: string; existingMemories: readonly string[] }, execute?: (system: string, user: string) => Promise<string>): Promise<MemoryExtraction> {
  if (typeof first === "string") return parseExtractedMemories(await execute?.(buildExtractionSystemPrompt(), buildExtractionUserPrompt(first)) ?? "NONE");
  first.executor.appendMessages([{ role: "system", content: buildExtractionSystemPrompt() }, { role: "user", content: buildExtractionUserPrompt(first.userMessage, first.agentMessage, first.existingMemories) }]);
  return parseExtractedMemories(await collectExecutorText(first.executor, first.ctx), first.existingMemories);
}

export interface MemoryStore { removeMemoryByContent(content: string): boolean; addMemory(content: string, now: number, kind: "profile" | "log"): MemoryRecord | null }
export function applyExtractedMemories(store: MemoryStore, extraction: MemoryExtraction, now: number, knownMemories: readonly string[]): { added: MemoryRecord[]; removed: string[] };
export function applyExtractedMemories(existing: readonly MemoryRecord[], extraction: MemoryExtraction, now?: number): MemoryRecord[];
export function applyExtractedMemories(first: MemoryStore | readonly MemoryRecord[], extraction: MemoryExtraction, now = Date.now(), knownMemories: readonly string[] = []): MemoryRecord[] | { added: MemoryRecord[]; removed: string[] } {
  if (Array.isArray(first)) {
    const removals = new Set(extraction.removals.map(memoryDedupeKey));
    const next = first.filter((record) => !removals.has(memoryDedupeKey(record.content)));
    const seen = new Set(next.map((record) => memoryDedupeKey(record.content)));
    for (const addition of extraction.additions) if (!seen.has(memoryDedupeKey(addition.content))) {
      seen.add(memoryDedupeKey(addition.content)); next.push({ id: `memory-${now}-${next.length}`, content: addition.content, createdAt: now, kind: addition.kind });
    }
    return next;
  }
  const store = first as MemoryStore;
  const known = new Set(knownMemories.map(memoryDedupeKey));
  const removed: string[] = [], added: MemoryRecord[] = [];
  for (const removal of extraction.removals) if (known.has(memoryDedupeKey(removal)) && store.removeMemoryByContent(removal)) removed.push(removal);
  for (const addition of extraction.additions) { const record = store.addMemory(addition.content, now, addition.kind); if (record != null) added.push(record); }
  return { added, removed };
}

export interface EpisodeTurn { readonly ts: number; readonly user: string; readonly agent: string }
export function buildEpisodeSystemPrompt(): string { return [
  MEMORY_EPISODE_PROMPT_MARKER,
  "You maintain the long-term memory of a personal desktop assistant named Grok Bot.",
  "You are given the most recent turns of a conversation between the user and Grok Bot, in order, each tagged with its date.",
  "Write ONE short journal-style sentence (two at most) capturing what the user and Grok Bot were actually working on across these turns \u2014 the throughline, key decisions, and outcomes \u2014 so it stays useful months from now.",
  'Anchor any time references with the absolute dates shown, never relative words like "yesterday". Drop greetings, acknowledgements, and anything ephemeral. Never invent details.',
  `Output just the sentence(s), no preamble or bullets. Output exactly ${MEMORY_EXTRACTION_NONE_SENTINEL} if nothing in this stretch is worth remembering.`,
].join("\n"); }
export function buildEpisodeUserPrompt(turns: readonly EpisodeTurn[]): string { return ["Recent turns, oldest first:", "", turns.map((turn) => [`(${formatMemoryDate(turn.ts)})`, ...(turn.user.trim() ? [`User: ${turn.user.trim()}`] : []), ...(turn.agent.trim() ? [`Grok Bot: ${turn.agent.trim()}`] : [])].join("\n")).join("\n\n")].join("\n"); }
export async function summarizeEpisode(args: { executor: TextExecutor; ctx: unknown; turns: readonly EpisodeTurn[] }): Promise<string | null> {
  if (args.turns.length === 0) return null;
  args.executor.appendMessages([{ role: "system", content: buildEpisodeSystemPrompt() }, { role: "user", content: buildEpisodeUserPrompt(args.turns) }]);
  const narrative = normalizeMemoryContent(await collectExecutorText(args.executor, args.ctx));
  return narrative.length === 0 || narrative.toUpperCase() === MEMORY_EXTRACTION_NONE_SENTINEL ? null : narrative;
}

export interface ProvenancedMemory extends MemoryRecord { readonly via: string }
export function mergeUserMemoryShards(shards: readonly { readonly via: string; readonly recall: MemoryRecall }[], limits: { readonly profileLimit: number; readonly recentLimit: number }): { profile: ProvenancedMemory[]; recent: ProvenancedMemory[] } {
  const merge = (records: ProvenancedMemory[], limit: number, rank = false): ProvenancedMemory[] => {
    const byKey = new Map<string, ProvenancedMemory>();
    for (const record of records) { const current = byKey.get(memoryDedupeKey(record.content)); if (current == null || record.createdAt > current.createdAt) byKey.set(memoryDedupeKey(record.content), record); }
    return [...byKey.values()].sort((a, b) => rank ? memoryRecallRank(b) - memoryRecallRank(a) || b.createdAt - a.createdAt : b.createdAt - a.createdAt || a.content.localeCompare(b.content)).slice(0, Math.max(0, Math.floor(limit)));
  };
  return {
    profile: merge(shards.flatMap((shard) => shard.recall.profile.map((record) => ({ ...record, via: shard.via }))), limits.profileLimit),
    recent: merge(shards.flatMap((shard) => shard.recall.recent.map((record) => ({ ...record, via: shard.via }))), limits.recentLimit, true),
  };
}

function provenancedLine(record: ProvenancedMemory): string { return `- (learned ${formatMemoryDate(record.createdAt)})${record.via.trim() ? ` [via ${record.via.trim()}]` : ""} ${record.content}`; }
const MEMORY_USER_PROFILE_CHAR_BUDGET = 4_000;
const MEMORY_USER_RECENT_CHAR_BUDGET = 2_000;
const MEMORY_PROJECT_PROFILE_CHAR_BUDGET = 2_500;
const MEMORY_PROJECT_RECENT_CHAR_BUDGET = 1_500;

function appendBudgetedProvenancedFacts(
  lines: string[],
  records: readonly ProvenancedMemory[],
  charBudget: number,
  moreLabel: string,
  grepHint: string,
): void {
  let budget = charBudget;
  let shown = 0;
  for (const record of records) {
    const line = provenancedLine(record);
    if (shown > 0 && line.length > budget) break;
    lines.push(line);
    budget -= line.length;
    shown += 1;
  }
  const omitted = records.length - shown;
  if (omitted > 0) {
    lines.push(`(${omitted} more shared ${moreLabel} on disk \u2014 grep ${grepHint} for them.)`);
  }
}

export function renderUserMemorySystemPrompt(recall: { readonly profile: readonly ProvenancedMemory[]; readonly recent: readonly ProvenancedMemory[] }, ctx: { readonly userMemoryDir?: string; readonly ownShardDir?: string }): string {
  if (ctx.userMemoryDir == null) return "";
  const hasFacts = recall.profile.length > 0 || recall.recent.length > 0;
  const lines = [
    "User memory: durable facts shared across every assistant this user runs \u2014 their name, timezone, lasting preferences, and anything all of the user's assistants should know. This is separate from your own memory (shown below) and is visible to all of them.",
    "Precedence: when a shared user fact conflicts with your OWN memory, prefer your own \u2014 it is curated for your role and may deliberately override a shared default.",
  ];
  if (ctx.ownShardDir != null) {
    lines.push(
      `User memory lives under ${ctx.userMemoryDir}, split into one shard folder per assistant so every file has a single writer. Your own shard is at ${ctx.ownShardDir} (a profile.md and log/YYYY-MM.md you can read and grep with Read and Shell on your own computer). To CHANGE shared user memory, prefer the update_state tool (target "memory", scope "user", action "write" or "forget"). Never edit another assistant's shard.`,
      'To fix or replace a shared fact another assistant recorded, write the corrected fact into YOUR shard via update_state \u2014 the newest wins on conflict. Record a fact here only when it is clearly about the user and useful to every assistant; keep role-specific facts in your own memory (scope "agent").',
    );
  }
  if (hasFacts) {
    lines.push("Shared facts are tagged [via <assistant>] so you can tell which assistant learned each one.");
  }
  if (recall.profile.length > 0) {
    lines.push("About the user (shared):");
    appendBudgetedProvenancedFacts(lines, recall.profile, MEMORY_USER_PROFILE_CHAR_BUDGET, "profile facts", "the user-memory/ folder");
  }
  if (recall.recent.length > 0) {
    lines.push("Recently (shared):");
    appendBudgetedProvenancedFacts(lines, recall.recent, MEMORY_USER_RECENT_CHAR_BUDGET, "log facts", "the user-memory/ folder");
  }
  if (recall.profile.length === 0 && recall.recent.length === 0) lines.push("No shared facts recorded yet.");
  return lines.join("\n");
}

export interface ProjectMemoryBlock { readonly slug: string; readonly name: string; readonly ownShardDir?: string; readonly recall: { readonly profile: readonly ProvenancedMemory[]; readonly recent: readonly ProvenancedMemory[] } }
function hasProjectFacts(block: ProjectMemoryBlock): boolean { return block.recall.profile.length > 0 || block.recall.recent.length > 0; }
export function selectProjectMemoryBlocks(blocks: readonly ProjectMemoryBlock[], injectedCap = 3): { injected: ProjectMemoryBlock[]; alsoMemberOf: Array<{ slug: string; name: string }> } {
  const ordered = [...blocks].sort((a, b) => Number(hasProjectFacts(b)) - Number(hasProjectFacts(a)) || Math.max(0, ...b.recall.profile.map((r) => r.createdAt), ...b.recall.recent.map((r) => r.createdAt)) - Math.max(0, ...a.recall.profile.map((r) => r.createdAt), ...a.recall.recent.map((r) => r.createdAt)) || a.slug.localeCompare(b.slug));
  const cap = Number.isFinite(injectedCap) && injectedCap > 0 ? Math.floor(injectedCap) : 0;
  return { injected: ordered.slice(0, cap), alsoMemberOf: ordered.slice(cap).map(({ slug, name }) => ({ slug, name })) };
}
export function projectMemoryHasFacts(recall: { readonly injected: readonly ProjectMemoryBlock[] }): boolean { return recall.injected.some(hasProjectFacts); }
export function renderProjectMemorySystemPrompt(recall: { readonly injected: readonly ProjectMemoryBlock[]; readonly alsoMemberOf: readonly { slug: string; name: string }[] }, ctx: { readonly projectsRootDir?: string }): string {
  if (ctx.projectsRootDir == null) return "";
  const lines = [
    "Project memory: durable facts shared by every assistant that has joined a project \u2014 the project's decisions, conventions, and state. Projects are optional and opt-in; joining one lets its memory into your prompt below.",
    "Precedence across memory tiers: on conflict prefer your OWN memory first, then project memory, then user memory \u2014 the most specific wins.",
    `Projects live under ${ctx.projectsRootDir}: each is a folder <slug>/ holding a project.md (frontmatter name/description) and memory/by-agent/<assistantId>/ shards (one per contributing assistant, a standard profile.md + log/). Read and grep those folders with Read and Shell on your own computer; prefer the update_state tool for every CHANGE:`,
    '  - Define a project: update_state target "project", action "create", project=<slug>, name=... (optional description). If the slug already exists this is create-is-join.',
    `  - Join or leave: update_state target "project", action "join" or "leave", project=<slug>. Only projects you have joined load below; to see who else is a member, grep the assistants' projects.json files.`,
    `  - Write project facts with update_state target "memory", scope "project", project=<slug>, action "write" or "forget" (never another assistant's shard); newest wins on conflict. Record a fact here only when it is about the project and useful to every member.`,
  ];
  for (const block of recall.injected) {
    lines.push(`Project "${block.name}" (${block.slug})${block.ownShardDir == null ? ":" : ` \u2014 your shard: ${block.ownShardDir}:`}`);
    const grepHint = "this project's memory/ folder";
    if (block.recall.profile.length > 0) {
      lines.push("About this project (shared):");
      appendBudgetedProvenancedFacts(lines, block.recall.profile, MEMORY_PROJECT_PROFILE_CHAR_BUDGET, "profile facts", grepHint);
    }
    if (block.recall.recent.length > 0) {
      lines.push("Recently (shared):");
      appendBudgetedProvenancedFacts(lines, block.recall.recent, MEMORY_PROJECT_RECENT_CHAR_BUDGET, "log facts", grepHint);
    }
    if (!hasProjectFacts(block)) lines.push("No shared facts recorded yet for this project.");
  }
  if (recall.alsoMemberOf.length > 0) lines.push(`Also a member of: ${recall.alsoMemberOf.map((p) => `${p.name} (${p.slug})`).join(", ")} \u2014 grep those project folders for their memory.`);
  return lines.join("\n");
}
