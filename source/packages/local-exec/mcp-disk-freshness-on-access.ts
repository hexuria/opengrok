import { createCounter, createHistogram } from "../metrics/index.js";
import type { Context } from "../context/core.js";
import { createLogger } from "../context/logger.js";
import type { McpStateServer } from "../proto/generated/agent/v1/mcp_exec_pb.js";
import { readMcpDiskCatalogToolNamesForProjectDir } from "./mcp-disk-catalog-read.js";
import { sanitizeServerName } from "./mcp.js";

const logger = createLogger("local-exec:mcp-disk-freshness-on-access");
const MCP_PATH_SEGMENT = "/mcps/";
const DISK_MCPS_FRESHNESS_DEBOUNCE_MS = 2_000;

const mcpDiscoveryFreshnessCheck = createCounter("mcp.discovery_freshness.check", {
  description: "MCP discovery surface freshness comparison outcome against canonical live tools",
  labelNames: ["surface", "outcome"],
});
const mcpDiscoveryFreshnessMissingTools = createHistogram("mcp.discovery_freshness.missing_tools", {
  description: "Number of tools present in canonical live state but missing from the observed discovery surface",
  labelNames: ["surface"],
});
const mcpDiscoveryFreshnessExtraTools = createHistogram("mcp.discovery_freshness.extra_tools", {
  description: "Number of tools present on the observed discovery surface but absent from canonical live state",
  labelNames: ["surface"],
});
const mcpDiscoveryFreshnessSymmetricDifference = createHistogram("mcp.discovery_freshness.symmetric_difference", {
  description: "Total symmetric difference between canonical live tools and the observed discovery surface",
  labelNames: ["surface"],
});

type McpState = { readonly servers: readonly McpStateServer[] };
export interface McpStateAccessor { getState(ctx: Context): Promise<McpState> }
type DiskCatalogReader = typeof readMcpDiskCatalogToolNamesForProjectDir;

const diskFreshnessDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function normalizePathForMcpsLayout(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.endsWith("/mcps") ? `${normalized}/` : normalized;
}

export function isMcpDirectoryPath(filePath: string | undefined): boolean {
  return filePath !== undefined && normalizePathForMcpsLayout(filePath).includes(MCP_PATH_SEGMENT);
}

type ParsedMcpsPath =
  | { readonly projectDir: string; readonly kind: "mcps_root" }
  | { readonly projectDir: string; readonly kind: "server"; readonly sanitizedServerFolder: string };

export function parseMcpsPath(filePath: string): ParsedMcpsPath | undefined {
  const normalized = normalizePathForMcpsLayout(filePath);
  const index = normalized.indexOf(MCP_PATH_SEGMENT);
  if (index === -1) return undefined;
  const projectDir = normalized.slice(0, index);
  const rest = normalized.slice(index + MCP_PATH_SEGMENT.length);
  const parts = rest.split("/").filter(Boolean);
  if (projectDir.length === 0) return undefined;
  if (parts.length === 0) return { projectDir, kind: "mcps_root" };
  return { projectDir, kind: "server", sanitizedServerFolder: parts[0]! };
}

function emitDiskMcpDiscoveryFreshness(args: {
  readonly ctx: Context;
  readonly serverIdentifier: string;
  readonly canonicalToolNames: readonly string[];
  readonly observedToolNames: readonly string[];
}): void {
  const observed = new Set(args.observedToolNames);
  const canonical = new Set(args.canonicalToolNames);
  const missingTools = args.canonicalToolNames.filter((toolName) => !observed.has(toolName));
  const extraTools = args.observedToolNames.filter((toolName) => !canonical.has(toolName));
  const outcome = missingTools.length === 0 && extraTools.length === 0 ? "match" : "mismatch";
  const tags = { surface: "disk" };
  mcpDiscoveryFreshnessCheck.increment(args.ctx, 1, { ...tags, outcome });
  mcpDiscoveryFreshnessMissingTools.histogram(args.ctx, missingTools.length, tags);
  mcpDiscoveryFreshnessExtraTools.histogram(args.ctx, extraTools.length, tags);
  mcpDiscoveryFreshnessSymmetricDifference.histogram(args.ctx, missingTools.length + extraTools.length, tags);
  if (outcome === "mismatch") {
    logger.warn(args.ctx, "mcp_disk_discovery_freshness_mismatch", {
      server_identifier: args.serverIdentifier,
      missing_tool_count: missingTools.length,
      extra_tool_count: extraTools.length,
    });
  }
}

async function runDiskMcpDiscoveryFreshness(args: {
  readonly ctx: Context;
  readonly mcpStateAccessor: McpStateAccessor;
  readonly projectDir: string;
  readonly sanitizedServerFolder: string;
  readonly readDiskCatalog: DiskCatalogReader;
  readonly state?: McpState;
}): Promise<void> {
  let state = args.state;
  if (state === undefined) {
    try { state = await args.mcpStateAccessor.getState(args.ctx); }
    catch (error) {
      logger.warn(args.ctx, "mcp_disk_state_read_failed", { error_type: error instanceof Error ? error.name : typeof error });
      return;
    }
  }
  const server = state.servers.find((candidate) => sanitizeServerName(candidate.serverIdentifier) === args.sanitizedServerFolder);
  if (server === undefined) return;
  let diskResult: Awaited<ReturnType<DiskCatalogReader>>;
  try { diskResult = await args.readDiskCatalog(args.projectDir, server.serverIdentifier); }
  catch (error) {
    logger.warn(args.ctx, "mcp_disk_catalog_read_failed", { error_type: error instanceof Error ? error.name : typeof error });
    return;
  }
  if (!diskResult.toolsDirExists) return;
  const canonicalToolNames = server.tools.map((tool) => tool.toolName).filter((toolName) => toolName.length > 0).sort((a, b) => a.localeCompare(b));
  emitDiskMcpDiscoveryFreshness({ ctx: args.ctx, serverIdentifier: server.serverIdentifier, canonicalToolNames, observedToolNames: diskResult.toolNames });
}

export function scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(
  ctx: Context,
  mcpStateAccessor: McpStateAccessor,
  filePath: string | undefined,
  readDiskCatalog: DiskCatalogReader = readMcpDiskCatalogToolNamesForProjectDir,
): void {
  if (!isMcpDirectoryPath(filePath) || filePath === undefined) return;
  const parsed = parseMcpsPath(filePath);
  if (parsed === undefined) return;
  const isMcpsRoot = parsed.kind === "mcps_root";
  const key = isMcpsRoot ? `${parsed.projectDir}\0__mcps_root__` : `${parsed.projectDir}\0${parsed.sanitizedServerFolder}`;
  const serverFolderForRun = isMcpsRoot ? undefined : parsed.sanitizedServerFolder;
  const existing = diskFreshnessDebounceTimers.get(key);
  if (existing !== undefined) clearTimeout(existing);
  const freshnessCtx = ctx;
  const timer = setTimeout(() => {
    diskFreshnessDebounceTimers.delete(key);
    const runFreshnessCheck = async (): Promise<void> => {
      if (isMcpsRoot) {
        const state = await mcpStateAccessor.getState(freshnessCtx);
        for (const server of state.servers) {
          await runDiskMcpDiscoveryFreshness({
            ctx: freshnessCtx,
            mcpStateAccessor,
            projectDir: parsed.projectDir,
            sanitizedServerFolder: sanitizeServerName(server.serverIdentifier),
            readDiskCatalog,
            state,
          });
        }
        return;
      }
      if (serverFolderForRun !== undefined) {
        await runDiskMcpDiscoveryFreshness({ ctx: freshnessCtx, mcpStateAccessor, projectDir: parsed.projectDir, sanitizedServerFolder: serverFolderForRun, readDiskCatalog });
      }
    };
    void runFreshnessCheck().catch((error) => {
      logger.warn(freshnessCtx, "mcp_disk_discovery_freshness_schedule_failed", { error_type: error instanceof Error ? error.name : typeof error });
    });
  }, DISK_MCPS_FRESHNESS_DEBOUNCE_MS);
  diskFreshnessDebounceTimers.set(key, timer);
}
