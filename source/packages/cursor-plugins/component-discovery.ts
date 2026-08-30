import { basename } from "node:path";
import yaml from "js-yaml";
import { isPathSafe, type PluginManifest } from "./manifest-parser.js";
import { PLUGIN_MCP_CONFIG_FILE_NAMES, resolvePluginMcpConfigFromReader } from "./mcp-parser.js";
import { inferMcpPlaceholderVariables, type PlaceholderProperty } from "./mcp-placeholder-variables.js";

const MARKDOWN_EXTENSIONS = [".md", ".mdc", ".markdown"];
const COMMAND_EXTENSIONS = [...MARKDOWN_EXTENSIONS, ".txt"];
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---/;
const EMPTY_METADATA_DESCRIPTION = "";

export interface PluginFileEntry { name: string; path: string; type: "file" | "dir" }
export interface PluginFileFetcher {
  listDirectory(path: string, visitedRealDirPaths?: Set<string>): Promise<PluginFileEntry[]>;
  fetchFile(path: string): Promise<{ content: string }>;
  fileExists(path: string): Promise<boolean>;
}
export interface PluginComponentDescriptor {
  name: string;
  path: string;
  description?: string | undefined;
  environments?: string[] | undefined;
  disabledEnvironments?: string[] | undefined;
}
export interface DiscoveredPluginComponents {
  skills: PluginComponentDescriptor[];
  agents: PluginComponentDescriptor[];
  hooks: PluginComponentDescriptor[];
  commands: PluginComponentDescriptor[];
  rules: PluginComponentDescriptor[];
  mcpServers: PluginComponentDescriptor[];
  mcpVariables: { type: "object"; properties: Record<string, PlaceholderProperty> } | undefined;
}
export type PluginDiscoveryManifest = Pick<PluginManifest, "commands" | "agents" | "skills" | "rules" | "hooks" | "mcpServers">;

function toKebabCase(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, ""); }
function normalizeEnvironmentList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) { const normalized = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0); return normalized.length === 0 ? undefined : normalized; }
  if (typeof value === "string") { const normalized = value.split(",").map(entry => entry.trim()).filter(entry => entry.length > 0); return normalized.length === 0 ? undefined : normalized; }
  return undefined;
}
function parseNameAndDescription(content: string): { name?: string | undefined; description?: string | undefined; environments?: string[] | undefined; disabledEnvironments?: string[] | undefined } {
  const frontmatterMatch = content.match(FRONTMATTER_REGEX); if (!frontmatterMatch) return {};
  try {
    const parsed = yaml.load(frontmatterMatch[1]!, { schema: yaml.JSON_SCHEMA }); if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>, metadata = record.metadata !== null && typeof record.metadata === "object" ? record.metadata as Record<string, unknown> : undefined;
    return { disabledEnvironments: normalizeEnvironmentList(record["disabled-environments"] ?? metadata?.disabledEnvironments), environments: normalizeEnvironmentList(record.environments ?? metadata?.environments), name: typeof record.name === "string" ? record.name : undefined, description: typeof record.description === "string" ? record.description : undefined };
  } catch {
    const raw = frontmatterMatch[1]!, nameMatch = raw.match(/^name:\s*(.+)$/m), descriptionMatch = raw.match(/^description:\s*(.+)$/m);
    return nameMatch || descriptionMatch ? { name: nameMatch ? nameMatch[1]!.trim() : undefined, description: descriptionMatch ? descriptionMatch[1]!.trim() : undefined } : {};
  }
}
function deriveNameFromPath(filePath: string): string { return toKebabCase(basename(filePath).replace(/\.(md|mdc|markdown|txt)$/i, "")); }
function deduplicateByName(components: PluginComponentDescriptor[]): PluginComponentDescriptor[] { const seen = new Set<string>(), result: PluginComponentDescriptor[] = []; for (const component of components) if (!seen.has(component.name)) { seen.add(component.name); result.push(component); } return result; }

export class PluginComponentDiscovery {
  constructor(private readonly fetcher: PluginFileFetcher) {}

  async discoverComponents(options: { basePath?: string | undefined; metadataOnly?: boolean | undefined; manifest?: PluginDiscoveryManifest | undefined } = {}): Promise<DiscoveredPluginComponents> {
    const basePath = options.basePath ?? "", basePrefix = basePath ? `${basePath}/` : "", metadataOnly = options.metadataOnly ?? false, manifest = options.manifest;
    let rootContents: PluginFileEntry[]; try { rootContents = await this.fetcher.listDirectory(basePath); } catch { rootContents = []; }
    const folderNames = new Set(rootContents.filter(item => item.type === "dir").map(item => item.name.toLowerCase()));
    const presentMcpConfigFiles = PLUGIN_MCP_CONFIG_FILE_NAMES.filter(name => rootContents.some(item => item.type === "file" && item.name === name));
    const hasRootSkillMd = rootContents.some(item => item.type === "file" && item.name === "SKILL.md");
    const [rootSkill, skills, agents, hooks, commands, rules, mcp] = await Promise.all([
      hasRootSkillMd && manifest?.skills === undefined ? this.discoverRootSkill(basePrefix, metadataOnly) : Promise.resolve(null),
      manifest?.skills !== undefined ? this.discoverFromManifestPaths(basePrefix, manifest.skills, true, MARKDOWN_EXTENSIONS, metadataOnly) : folderNames.has("skills") ? this.discoverSkills(`${basePrefix}skills`, metadataOnly) : Promise.resolve([]),
      manifest?.agents !== undefined ? this.discoverFromManifestPaths(basePrefix, manifest.agents, false, MARKDOWN_EXTENSIONS, metadataOnly) : folderNames.has("agents") ? this.discoverMarkdownComponents(`${basePrefix}agents`, MARKDOWN_EXTENSIONS, metadataOnly) : Promise.resolve([]),
      manifest?.hooks !== undefined ? this.discoverHooksFromManifest(basePrefix, manifest.hooks, metadataOnly) : folderNames.has("hooks") ? this.discoverHooksFromJson(`${basePrefix}hooks/hooks.json`, metadataOnly) : Promise.resolve([]),
      manifest?.commands !== undefined ? this.discoverFromManifestPaths(basePrefix, manifest.commands, false, COMMAND_EXTENSIONS, metadataOnly) : folderNames.has("commands") ? this.discoverMarkdownComponents(`${basePrefix}commands`, COMMAND_EXTENSIONS, metadataOnly) : Promise.resolve([]),
      manifest?.rules !== undefined ? this.discoverFromManifestPaths(basePrefix, manifest.rules, false, MARKDOWN_EXTENSIONS, metadataOnly) : folderNames.has("rules") ? this.discoverMarkdownComponents(`${basePrefix}rules`, MARKDOWN_EXTENSIONS, metadataOnly) : Promise.resolve([]),
      this.discoverMcpServers(basePrefix, manifest?.mcpServers, presentMcpConfigFiles),
    ]);
    return { skills: deduplicateByName(rootSkill ? [rootSkill, ...skills] : skills), agents: deduplicateByName(agents), hooks, commands: deduplicateByName(commands), rules: deduplicateByName(rules), mcpServers: mcp.servers, mcpVariables: mcp.variables };
  }

  private async discoverHooksFromJson(hooksJsonPath: string, metadataOnly = false): Promise<PluginComponentDescriptor[]> {
    try { if (!await this.fetcher.fileExists(hooksJsonPath)) return []; const config = JSON.parse((await this.fetcher.fetchFile(hooksJsonPath)).content) as { hooks?: unknown }; if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) return []; return Object.keys(config.hooks).map(name => ({ name: toKebabCase(name), path: hooksJsonPath, description: metadataOnly ? EMPTY_METADATA_DESCRIPTION : `Hook: ${name}` })); } catch { return []; }
  }
  private async discoverHooksFromManifest(basePrefix: string, hooksConfig: NonNullable<PluginManifest["hooks"]>, metadataOnly = false): Promise<PluginComponentDescriptor[]> {
    if (typeof hooksConfig === "string") { if (!isPathSafe(hooksConfig)) return []; const fullPath = `${basePrefix}${hooksConfig.replace(/^\.\//, "")}`; return this.discoverHooksFromJson(fullPath.endsWith(".json") ? fullPath : `${fullPath}/hooks.json`, metadataOnly); }
    const hooksRecord = hooksConfig as Record<string, unknown>, hooks = hooksRecord.hooks ?? hooksRecord; if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];
    return Object.keys(hooks).map(name => ({ name: toKebabCase(name), path: "manifest", description: metadataOnly ? EMPTY_METADATA_DESCRIPTION : `Hook: ${name}` }));
  }

  private async discoverFromManifestPaths(basePrefix: string, paths: string | string[], isSkillDir = false, extensions = MARKDOWN_EXTENSIONS, metadataOnly = false): Promise<PluginComponentDescriptor[]> {
    if (typeof paths === "string") { if (!isPathSafe(paths)) return []; const directory = `${basePrefix}${paths.replace(/^\.\//, "")}`.replace(/\/$/, ""); return isSkillDir ? this.discoverSkills(directory, metadataOnly) : this.discoverMarkdownComponents(directory, extensions, metadataOnly); }
    const results: PluginComponentDescriptor[] = [];
    for (const itemPath of paths) {
      try {
        if (!isPathSafe(itemPath)) continue; const fullPath = `${basePrefix}${itemPath.replace(/^\.\//, "")}`;
        if (isSkillDir) {
          const skillPath = fullPath.endsWith("SKILL.md") ? fullPath : `${fullPath.replace(/\/$/, "")}/SKILL.md`;
          if (!await this.fetcher.fileExists(skillPath)) { results.push(...await this.discoverSkills(fullPath.replace(/\/$/, ""), metadataOnly)); continue; }
          const directory = fullPath.endsWith("SKILL.md") ? fullPath.slice(0, -"SKILL.md".length).replace(/\/$/, "") : fullPath; let name = deriveNameFromPath(directory), description = metadataOnly ? EMPTY_METADATA_DESCRIPTION : undefined;
          if (!metadataOnly) { const parsed = parseNameAndDescription((await this.fetcher.fetchFile(skillPath)).content); name = parsed.name ?? name; description = parsed.description; if (name) { const component: PluginComponentDescriptor = { disabledEnvironments: parsed.disabledEnvironments, environments: parsed.environments, name: toKebabCase(name), path: skillPath }; if (description !== undefined) component.description = description; results.push(component); } continue; }
          if (name) { const component: PluginComponentDescriptor = { name: toKebabCase(name), path: skillPath }; if (description !== undefined) component.description = description; results.push(component); }
        } else {
          if (!await this.fetcher.fileExists(fullPath)) continue; let name = deriveNameFromPath(fullPath), description = metadataOnly ? EMPTY_METADATA_DESCRIPTION : undefined;
          if (!metadataOnly) { const parsed = parseNameAndDescription((await this.fetcher.fetchFile(fullPath)).content); name = parsed.name ?? name; description = parsed.description; }
          if (name) { const component: PluginComponentDescriptor = { name: toKebabCase(name), path: fullPath }; if (description !== undefined) component.description = description; results.push(component); }
        }
      } catch {}
    }
    return results;
  }

  private async discoverMarkdownComponents(folderPath: string, extensions = MARKDOWN_EXTENSIONS, metadataOnly = false, visited = new Set<string>()): Promise<PluginComponentDescriptor[]> {
    let contents: PluginFileEntry[]; try { contents = await this.fetcher.listDirectory(folderPath, visited); } catch { return []; }
    const files = contents.filter(item => item.type === "file" && extensions.some(extension => item.name.endsWith(extension))), directories = contents.filter(item => item.type === "dir");
    const [fileResults, directoryResults] = await Promise.all([
      Promise.all(files.map(async file => { try { let name = deriveNameFromPath(file.name), description = metadataOnly ? EMPTY_METADATA_DESCRIPTION : undefined; if (!metadataOnly) { const parsed = parseNameAndDescription((await this.fetcher.fetchFile(file.path)).content); name = parsed.name ? toKebabCase(parsed.name) : name; description = parsed.description; } if (!name) return null; const component: PluginComponentDescriptor = { name, path: file.path }; if (description !== undefined) component.description = description; return component; } catch { return null; } })),
      Promise.all(directories.map(directory => this.discoverMarkdownComponents(directory.path, extensions, metadataOnly, visited))),
    ]);
    return [...fileResults.filter((component): component is PluginComponentDescriptor => component !== null), ...directoryResults.flat()];
  }

  private async discoverRootSkill(basePrefix: string, metadataOnly = false): Promise<PluginComponentDescriptor | null> {
    try {
      const skillPath = `${basePrefix}SKILL.md`, directoryName = basename(basePrefix.replace(/[\\/]+$/, "")); let name = metadataOnly ? toKebabCase(directoryName || deriveNameFromPath(skillPath)) : toKebabCase(directoryName), description = metadataOnly ? EMPTY_METADATA_DESCRIPTION : undefined;
      if (!metadataOnly) { const parsed = parseNameAndDescription((await this.fetcher.fetchFile(skillPath)).content); name = parsed.name ? toKebabCase(parsed.name) : name; description = parsed.description; if (!name) return null; const component: PluginComponentDescriptor = { disabledEnvironments: parsed.disabledEnvironments, environments: parsed.environments, name, path: skillPath }; if (description !== undefined) component.description = description; return component; }
      if (!name) return null; return { name, path: skillPath, ...(description !== undefined ? { description } : {}) };
    } catch { return null; }
  }

  private async discoverSkills(skillsPath: string, metadataOnly = false): Promise<PluginComponentDescriptor[]> {
    let contents: PluginFileEntry[]; try { contents = await this.fetcher.listDirectory(skillsPath); } catch { return []; }
    const results = await Promise.all(contents.filter(item => item.type === "dir").map(async directory => {
      try { const skillPath = `${directory.path}/SKILL.md`; if (!await this.fetcher.fileExists(skillPath)) return null; if (metadataOnly) { const name = toKebabCase(directory.name); return name ? { name, path: skillPath, description: EMPTY_METADATA_DESCRIPTION } : null; } const parsed = parseNameAndDescription((await this.fetcher.fetchFile(skillPath)).content), name = parsed.name ? toKebabCase(parsed.name) : toKebabCase(directory.name); if (!name) return null; const component: PluginComponentDescriptor = { disabledEnvironments: parsed.disabledEnvironments, environments: parsed.environments, name, path: skillPath }; if (parsed.description !== undefined) component.description = parsed.description; return component; } catch { return null; }
    }));
    return results.filter((component): component is PluginComponentDescriptor => component !== null);
  }

  private async discoverMcpServers(basePrefix: string, manifestMcpServers: unknown, presentMcpConfigFiles: readonly string[]): Promise<{ servers: PluginComponentDescriptor[]; variables: DiscoveredPluginComponents["mcpVariables"] }> {
    const fetched = new Map<string, Promise<string | null>>();
    const readFileContent = async (relativePath: string): Promise<string | null> => { const cached = fetched.get(relativePath); if (cached !== undefined) return cached; const pending = this.fetcher.fetchFile(`${basePrefix}${relativePath}`).then(({ content }) => content).catch(() => null); fetched.set(relativePath, pending); return pending; };
    const resolveWith = async (manifestPrecedence: "fill" | "override") => resolvePluginMcpConfigFromReader(readFileContent, manifestMcpServers, manifestMcpServers !== undefined ? "manifest" : undefined, { fallbackFileNames: presentMcpConfigFiles, manifestPrecedence, toSourcePath: relativePath => `${basePrefix}${relativePath}`, parserOptions: { skipExpansion: true } });
    const resolved = await resolveWith("fill"); if (resolved?.mcpServers === undefined) return { servers: [], variables: undefined };
    const runtimeResolved = manifestMcpServers === undefined ? resolved : await resolveWith("override");
    return { servers: Object.keys(resolved.mcpServers).map(name => ({ name: toKebabCase(name), path: resolved.mcpServerSourcePaths?.[name] ?? "manifest" })), variables: inferMcpPlaceholderVariables(runtimeResolved ?? resolved) };
  }
}
