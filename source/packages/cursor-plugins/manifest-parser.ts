import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { CapabilitiesSchema } from "./capabilities.js";
import { readSchemaId, resolveSchemaVersion } from "./schema-version.js";

export const MAX_MANIFEST_SIZE_BYTES = 10 * 1024 * 1024;
const KEBAB_CASE_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
export const PLUGIN_MANIFEST_PATHS = [
  ".cursor-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "plugin.json",
] as const;
export const PLUGIN_ROOT_DIR_NAMES = [".cursor-plugin", ".claude-plugin"] as const;
export const MARKETPLACE_MANIFEST_PATHS = [
  ".cursor-plugin/marketplace.json",
  ".claude-plugin/marketplace.json",
] as const;

const GitHubSourceSchema = z.object({
  source: z.literal("github"),
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "Must be in owner/repo format"),
  ref: z.string().optional(),
  sha: z.string().length(40, "SHA must be 40 characters").regex(/^[a-f0-9]+$/, "SHA must be hexadecimal").optional(),
});
const GitUrlSourceSchema = z.object({
  source: z.literal("url"),
  url: z.string().url().endsWith(".git", "URL must end with .git"),
  ref: z.string().optional(),
  sha: z.string().length(40, "SHA must be 40 characters").regex(/^[a-f0-9]+$/, "SHA must be hexadecimal").optional(),
});
const GitSubdirSourceSchema = z.object({
  source: z.literal("git-subdir"),
  url: z.string().url().endsWith(".git", "URL must end with .git"),
  path: z.string().min(1),
  ref: z.string().optional(),
  sha: z.string().length(40, "SHA must be 40 characters").regex(/^[a-f0-9]+$/, "SHA must be hexadecimal").optional(),
});
export const PluginSourceSchema = z.union([z.string(), GitHubSourceSchema, GitUrlSourceSchema, GitSubdirSourceSchema]);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

const MIN_CLIENT_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const MinClientVersionsSchema = z.object({
  cursor: z.string().regex(MIN_CLIENT_VERSION_PATTERN, "Must be a semver version (X.Y.Z)").optional(),
  sand: z.string().regex(MIN_CLIENT_VERSION_PATTERN, "Must be a semver version (X.Y.Z)").optional(),
});
const AuthorSchema = z.object({ name: z.string().min(1, "Author name is required"), email: z.string().email().optional() });
const PluginVariablePrimitiveTypeSchema = z.enum(["string", "number", "integer", "boolean", "object", "array", "null"]);
const PluginVariableTypeSchema = z.union([
  PluginVariablePrimitiveTypeSchema,
  z.array(PluginVariablePrimitiveTypeSchema).nonempty().superRefine((types, ctx) => {
    if (new Set(types).size !== types.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Schema type arrays must not contain duplicates" });
  }),
]);

export interface PluginVariableSchema {
  type?: z.infer<typeof PluginVariableTypeSchema> | undefined;
  title?: string | undefined;
  description?: string | undefined;
  format?: string | undefined;
  writeOnly?: boolean | undefined;
  default?: unknown;
  enum?: [unknown, ...unknown[]] | undefined;
  const?: unknown;
  properties?: Record<string, PluginVariableSchema> | undefined;
  required?: string[] | undefined;
  additionalProperties?: boolean | PluginVariableSchema | undefined;
  items?: PluginVariableSchema | PluginVariableSchema[] | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  exclusiveMinimum?: number | undefined;
  exclusiveMaximum?: number | undefined;
  multipleOf?: number | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  uniqueItems?: boolean | undefined;
  minProperties?: number | undefined;
  maxProperties?: number | undefined;
}

function validatePluginVariableSchemaShape(schema: PluginVariableSchema, ctx: z.RefinementCtx): void {
  if (schema.required !== undefined) {
    if (schema.properties === undefined) {
      for (const propertyName of schema.required) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Required property "${propertyName}" must be declared in properties`, path: ["required"] });
    } else {
      for (const propertyName of schema.required) if (!(propertyName in schema.properties)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Required property "${propertyName}" must be declared in properties`, path: ["required"] });
    }
  }
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minLength must be less than or equal to maxLength", path: ["minLength"] });
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minimum must be less than or equal to maximum", path: ["minimum"] });
  if (schema.exclusiveMinimum !== undefined && schema.exclusiveMaximum !== undefined && schema.exclusiveMinimum >= schema.exclusiveMaximum) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exclusiveMinimum must be less than exclusiveMaximum", path: ["exclusiveMinimum"] });
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minItems must be less than or equal to maxItems", path: ["minItems"] });
  if (schema.minProperties !== undefined && schema.maxProperties !== undefined && schema.minProperties > schema.maxProperties) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minProperties must be less than or equal to maxProperties", path: ["minProperties"] });
}

const PluginVariableSchemaSchema: z.ZodType<PluginVariableSchema> = z.lazy(() => z.object({
  type: PluginVariableTypeSchema.optional(), title: z.string().optional(), description: z.string().optional(), format: z.string().optional(), writeOnly: z.boolean().optional(), default: z.unknown().optional(), enum: z.array(z.any()).nonempty().optional(), const: z.unknown().optional(),
  properties: z.record(z.string(), PluginVariableSchemaSchema).optional(), required: z.array(z.string()).optional(), additionalProperties: z.union([z.boolean(), PluginVariableSchemaSchema]).optional(), items: z.union([PluginVariableSchemaSchema, z.array(PluginVariableSchemaSchema)]).optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(), minimum: z.number().optional(), maximum: z.number().optional(), exclusiveMinimum: z.number().optional(), exclusiveMaximum: z.number().optional(), multipleOf: z.number().positive().optional(), minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(), uniqueItems: z.boolean().optional(), minProperties: z.number().int().nonnegative().optional(), maxProperties: z.number().int().nonnegative().optional(),
}).strict().superRefine(validatePluginVariableSchemaShape));

export function parsePluginVariablesJsonSchema(schema: unknown): z.SafeParseReturnType<unknown, PluginVariableSchema> {
  const result = PluginVariableSchemaSchema.superRefine((value, ctx) => {
    if (value.type !== "object") ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Plugin variable schemas must declare type "object"', path: ["type"] });
  }).safeParse(schema);
  return result.success ? { success: true, data: result.data } : result;
}

const PluginVariablesJsonSchemaSchema = z.unknown().superRefine((value, ctx) => {
  const result = parsePluginVariablesJsonSchema(value);
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue(issue);
}).transform(value => value as PluginVariableSchema);

const MarketplacePluginEntrySchema = z.object({
  name: z.string().min(1).transform(name => name.toLowerCase()).refine(name => KEBAB_CASE_PATTERN.test(name), "Name must be kebab-case (lowercase alphanumeric with hyphens and periods)"),
  displayName: z.string().optional(), source: PluginSourceSchema, description: z.string().optional(), version: z.string().optional(), author: AuthorSchema.optional(), publisher: z.string().min(1).optional(), homepage: z.string().url().optional(), repository: z.string().url().optional(), license: z.string().optional(), keywords: z.array(z.string()).optional(), capabilities: CapabilitiesSchema.optional(), logo: z.string().optional(), category: z.string().optional(), tags: z.array(z.string()).optional(), minClientVersions: MinClientVersionsSchema.optional(), strict: z.boolean().default(true), commands: z.union([z.string(), z.array(z.string())]).optional(), agents: z.union([z.string(), z.array(z.string())]).optional(), skills: z.union([z.string(), z.array(z.string())]).optional(), rules: z.union([z.string(), z.array(z.string())]).optional(), hooks: z.union([z.string(), z.record(z.unknown())]).optional(), variables: PluginVariablesJsonSchemaSchema.optional(), mcpServers: z.union([z.string(), z.record(z.unknown()), z.array(z.union([z.string(), z.record(z.unknown())]))]).optional(),
});
export type MarketplacePluginEntry = z.infer<typeof MarketplacePluginEntrySchema>;

const PluginManifestSchema = z.object({
  name: z.string().min(1).regex(KEBAB_CASE_PATTERN, "Name must be kebab-case (lowercase alphanumeric with hyphens and periods)"), displayName: z.string().optional(), description: z.string().optional(), version: z.string().optional(), author: AuthorSchema.optional(), publisher: z.string().min(1).optional(), homepage: z.string().url().optional(), repository: z.string().url().optional(), license: z.string().optional(), logo: z.string().optional(), keywords: z.array(z.string()).optional(), capabilities: CapabilitiesSchema.optional(), minClientVersions: MinClientVersionsSchema.optional(), commands: z.union([z.string(), z.array(z.string())]).optional(), agents: z.union([z.string(), z.array(z.string())]).optional(), skills: z.union([z.string(), z.array(z.string())]).optional(), rules: z.union([z.string(), z.array(z.string())]).optional(), hooks: z.union([z.string(), z.record(z.unknown())]).optional(), variables: PluginVariablesJsonSchemaSchema.optional(), mcpServers: z.union([z.string(), z.record(z.unknown()), z.array(z.union([z.string(), z.record(z.unknown())]))]).optional(),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

function parsePluginMinClientVersions(value: unknown): z.infer<typeof MinClientVersionsSchema> | undefined {
  const result = MinClientVersionsSchema.safeParse(value);
  return !result.success || (result.data.cursor === undefined && result.data.sand === undefined) ? undefined : result.data;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function normalizeMarketplaceName(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, ""); }
function fallbackMarketplaceName(options: { repoName?: string; fallbackId?: string }): string {
  const repoName = options.repoName !== undefined ? normalizeMarketplaceName(options.repoName) : "";
  return repoName.length > 0 ? repoName : `cursor-marketplace-${options.fallbackId ?? randomUUID()}`;
}
function readMarketplaceName(json: unknown, options: { repoName?: string; fallbackId?: string }): string {
  if (isRecord(json) && typeof json.name === "string") { const name = normalizeMarketplaceName(json.name); if (name.length > 0) return name; }
  return fallbackMarketplaceName(options);
}
function readOwner(json: unknown): { name: string; email?: string } {
  if (isRecord(json) && isRecord(json.owner)) {
    const name = typeof json.owner.name === "string" && json.owner.name.trim().length > 0 ? json.owner.name : "Unknown";
    const email = typeof json.owner.email === "string" && json.owner.email.trim().length > 0 ? json.owner.email : undefined;
    return { name, ...(email !== undefined ? { email } : {}) };
  }
  return { name: "Unknown" };
}
function readOptionalString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function readStringArray(value: unknown): string[] | undefined { if (!Array.isArray(value)) return undefined; const strings = value.filter((item): item is string => typeof item === "string"); return strings.length > 0 ? strings : undefined; }
function readComponentPaths(value: unknown): string | string[] | undefined { return typeof value === "string" ? value : readStringArray(value); }
function readMetadata(json: unknown): { description?: string | undefined; version?: string | undefined; pluginRoot?: string | undefined } | undefined {
  if (!isRecord(json) || !isRecord(json.metadata)) return undefined;
  const metadata = { description: readOptionalString(json.metadata.description), version: readOptionalString(json.metadata.version), pluginRoot: readOptionalString(json.metadata.pluginRoot) };
  return metadata.description !== undefined || metadata.version !== undefined || metadata.pluginRoot !== undefined ? metadata : undefined;
}
function readAuthor(value: unknown): { name: string; email?: string } | undefined {
  if (!isRecord(value)) return undefined; const name = readOptionalString(value.name); if (name === undefined || name.length === 0) return undefined; const email = readOptionalString(value.email); return { name, ...(email !== undefined ? { email } : {}) };
}
function readMcpServers(value: unknown): string | Record<string, unknown> | Array<string | Record<string, unknown>> | undefined {
  if (typeof value === "string" || isRecord(value)) return value;
  if (Array.isArray(value)) { const servers = value.filter((item): item is string | Record<string, unknown> => typeof item === "string" || isRecord(item)); return servers.length > 0 ? servers : undefined; }
  return undefined;
}
function readHooks(value: unknown): string | Record<string, unknown> | undefined { return typeof value === "string" || isRecord(value) ? value : undefined; }
function readVariables(value: unknown): PluginVariableSchema | undefined { if (value === undefined) return undefined; const result = parsePluginVariablesJsonSchema(value); return result.success ? result.data : undefined; }
function readPluginSource(value: unknown): PluginSource | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (value.source === "github" && typeof value.repo === "string" && value.repo.length > 0) return { source: "github", repo: value.repo, ref: readOptionalString(value.ref), sha: readOptionalString(value.sha) };
  if ((value.source === "url" || value.source === undefined) && typeof value.url === "string" && value.url.length > 0) return { source: "url", url: value.url, ref: readOptionalString(value.ref), sha: readOptionalString(value.sha) };
  if (value.source === "git-subdir" && typeof value.url === "string" && value.url.length > 0 && typeof value.path === "string" && value.path.length > 0) return { source: "git-subdir", url: value.url, path: value.path, ref: readOptionalString(value.ref), sha: readOptionalString(value.sha) };
  if (typeof value.repo === "string" && value.repo.length > 0) return { source: "github", repo: value.repo, ref: readOptionalString(value.ref), sha: readOptionalString(value.sha) };
  return undefined;
}
function derivePluginNameFromSource(source: PluginSource): string | undefined {
  if (typeof source === "string") { const name = normalizeMarketplaceName(basename(source)); return name.length > 0 ? name : undefined; }
  if (source.source === "github") { const name = normalizeMarketplaceName(source.repo.split("/").at(-1) ?? ""); return name.length > 0 ? name : undefined; }
  if (source.source === "git-subdir") { const name = normalizeMarketplaceName(basename(source.path)); return name.length > 0 ? name : undefined; }
  let urlPath = source.url; try { urlPath = new URL(source.url).pathname; } catch {}
  while (urlPath.endsWith("/")) urlPath = urlPath.slice(0, -1);
  if (urlPath.toLowerCase().endsWith(".git")) urlPath = urlPath.slice(0, -4);
  const name = normalizeMarketplaceName(basename(urlPath)); return name.length > 0 ? name : undefined;
}

interface SkippedPluginEntry { index: number; name?: string; error: string }
function readMarketplacePluginEntry(rawEntry: unknown, index: number): { entry: MarketplacePluginEntry } | { skippedEntry: SkippedPluginEntry } {
  if (!isRecord(rawEntry)) return { skippedEntry: { index, error: `Plugin entry at index ${index} is not an object` } };
  const source = readPluginSource(rawEntry.source);
  if (source === undefined) { const rawName = readOptionalString(rawEntry.name); return { skippedEntry: { index, ...(rawName !== undefined && rawName.length > 0 ? { name: rawName } : {}), error: `Plugin entry at index ${index} has no usable source` } }; }
  const nameFromEntry = typeof rawEntry.name === "string" ? normalizeMarketplaceName(rawEntry.name) : "";
  const name = nameFromEntry || derivePluginNameFromSource(source);
  if (name === undefined) return { skippedEntry: { index, error: `Plugin entry at index ${index} has no usable name` } };
  const capabilitiesResult = CapabilitiesSchema.safeParse(rawEntry.capabilities);
  if (rawEntry.capabilities !== undefined && !capabilitiesResult.success) return { skippedEntry: { index, name, error: `Plugin entry at index ${index} has invalid capabilities: ${capabilitiesResult.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join(", ")}` } };
  const capabilities = capabilitiesResult.success ? capabilitiesResult.data : undefined;
  const minClientVersions = parsePluginMinClientVersions(rawEntry.minClientVersions);
  return { entry: {
    name, displayName: readOptionalString(rawEntry.displayName), source, description: readOptionalString(rawEntry.description), version: readOptionalString(rawEntry.version), author: readAuthor(rawEntry.author), publisher: readOptionalString(rawEntry.publisher), homepage: readOptionalString(rawEntry.homepage), repository: readOptionalString(rawEntry.repository), license: readOptionalString(rawEntry.license), keywords: readStringArray(rawEntry.keywords), logo: readOptionalString(rawEntry.logo), category: readOptionalString(rawEntry.category), tags: readStringArray(rawEntry.tags), strict: typeof rawEntry.strict === "boolean" ? rawEntry.strict : true, commands: readComponentPaths(rawEntry.commands), agents: readComponentPaths(rawEntry.agents), skills: readComponentPaths(rawEntry.skills), rules: readComponentPaths(rawEntry.rules), hooks: readHooks(rawEntry.hooks), variables: readVariables(rawEntry.variables), mcpServers: readMcpServers(rawEntry.mcpServers), ...(capabilities !== undefined ? { capabilities } : {}), ...(minClientVersions !== undefined ? { minClientVersions } : {}),
  } };
}

export interface MarketplaceManifest {
  name: string;
  owner: { name: string; email?: string };
  description?: string | undefined;
  plugins: MarketplacePluginEntry[];
  metadata?: { description?: string | undefined; version?: string | undefined; pluginRoot?: string | undefined } | undefined;
  skippedPluginEntries: SkippedPluginEntry[];
}

export function parseMarketplaceManifest(content: string, options: { repoName?: string; fallbackId?: string } = {}): { success: true; data: MarketplaceManifest } | { success: false; error: string } {
  if (content.length > MAX_MANIFEST_SIZE_BYTES) return { success: false, error: `Manifest exceeds maximum size of ${MAX_MANIFEST_SIZE_BYTES} bytes` };
  let json: unknown; try { json = JSON.parse(content); } catch (error) { return { success: false, error: `Invalid JSON: ${error instanceof Error ? error.message : "Unknown error"}` }; }
  if (!isRecord(json)) return { success: false, error: "Invalid marketplace manifest: expected a JSON object" };
  const validPlugins: MarketplacePluginEntry[] = [], skippedPluginEntries: SkippedPluginEntry[] = [], seenNames = new Set<string>();
  const rawPlugins = Array.isArray(json.plugins) ? json.plugins : [];
  rawPlugins.forEach((rawEntry, index) => {
    const entryResult = readMarketplacePluginEntry(rawEntry, index);
    if ("skippedEntry" in entryResult) { skippedPluginEntries.push(entryResult.skippedEntry); return; }
    if (seenNames.has(entryResult.entry.name)) { skippedPluginEntries.push({ index, name: entryResult.entry.name, error: `Duplicate plugin name "${entryResult.entry.name}" at index ${index}` }); return; }
    seenNames.add(entryResult.entry.name); validPlugins.push(entryResult.entry);
  });
  return { success: true, data: { name: readMarketplaceName(json, options), owner: readOwner(json), description: readOptionalString(json.description), plugins: validPlugins, metadata: readMetadata(json), skippedPluginEntries } };
}

export function parsePluginManifest(content: string): { success: true; data: PluginManifest; unrecognizedSchemaId?: string } | { success: false; error: string; details?: z.ZodError } {
  if (content.length > MAX_MANIFEST_SIZE_BYTES) return { success: false, error: `Manifest exceeds maximum size of ${MAX_MANIFEST_SIZE_BYTES} bytes` };
  let json: unknown; try { json = JSON.parse(content); } catch (error) { return { success: false, error: `Invalid JSON: ${error instanceof Error ? error.message : "Unknown error"}` }; }
  const schema = resolveSchemaVersion(readSchemaId(json));
  const result = PluginManifestSchema.safeParse(json);
  if (!result.success) return { success: false, error: `Invalid plugin manifest: ${result.error.errors.map(error => `${error.path.join(".")}: ${error.message}`).join(", ")}`, details: result.error };
  return { success: true, data: result.data, ...(schema.kind === "unsupported" ? { unrecognizedSchemaId: schema.id } : {}) };
}

export type ClassifiedMarketplaceEntry =
  | { entry: MarketplacePluginEntry; kind: "local"; localPath: string }
  | { entry: MarketplacePluginEntry; kind: "unresolvable"; rawSource: string }
  | { entry: MarketplacePluginEntry; kind: "external-github" | "external-url"; externalUrl: string; externalRef?: string | undefined; externalSha?: string | undefined; effectiveRef?: string | undefined }
  | { entry: MarketplacePluginEntry; kind: "external-git-subdir"; externalUrl: string; externalRef?: string | undefined; externalSha?: string | undefined; effectiveRef?: string | undefined; subdirPath: string };

export function parseAndClassifyManifestEntries(plugins: readonly MarketplacePluginEntry[], pluginRoot?: string): ClassifiedMarketplaceEntry[] {
  const results: ClassifiedMarketplaceEntry[] = [];
  for (const entry of plugins) {
    const source = entry.source;
    if (typeof source === "string") { const resolved = resolvePluginSourcePath(source, pluginRoot); results.push(resolved !== null ? { entry, kind: "local", localPath: resolved } : { entry, kind: "unresolvable", rawSource: source }); continue; }
    switch (source.source) {
      case "github": results.push({ entry, kind: "external-github", externalUrl: `https://github.com/${source.repo}.git`, externalRef: source.ref, externalSha: source.sha, effectiveRef: source.sha ?? source.ref }); break;
      case "url": results.push({ entry, kind: "external-url", externalUrl: source.url, externalRef: source.ref, externalSha: source.sha, effectiveRef: source.sha ?? source.ref }); break;
      case "git-subdir": results.push({ entry, kind: "external-git-subdir", externalUrl: source.url, externalRef: source.ref, externalSha: source.sha, effectiveRef: source.sha ?? source.ref, subdirPath: source.path }); break;
    }
  }
  return results;
}

export function resolvePluginSourcePath(source: PluginSource, pluginRoot?: string): string | null {
  if (typeof source !== "string") return null;
  let resolvedPath = source;
  if (resolvedPath.startsWith("./")) resolvedPath = resolvedPath.slice(2);
  if (pluginRoot !== undefined) { let root = pluginRoot; if (root.startsWith("./")) root = root.slice(2); if (root.endsWith("/")) root = root.slice(0, -1); resolvedPath = `${root}/${resolvedPath}`; }
  return resolvedPath || ".";
}
export function containsPluginRootDir(entryNames: readonly string[]): boolean { return entryNames.some(name => (PLUGIN_ROOT_DIR_NAMES as readonly string[]).includes(name)); }
export function isPathSafe(candidatePath: string): boolean { return !candidatePath.includes("..") && !isAbsolute(candidatePath) && !candidatePath.includes("://"); }
