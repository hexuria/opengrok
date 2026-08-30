import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { packPluginArtifact } from "../../../packages/cursor-plugins/tarball.js";
import { restoreSkillsFromPluginDir } from "../../../packages/cursor-plugins/skill-plugin-restore.js";
import { synthesizeSkillPluginDir } from "../../../packages/cursor-plugins/skill-plugin-synthesizer.js";
import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import {
  GetTeamsRequest,
  PublishPluginRequest,
  UnpublishPluginRequest,
} from "../../../packages/proto/generated/aiserver/v1/dashboard_pb.js";
import { errorLogTag } from "../../../shared/errors.js";
import {
  createSandCursorBackendClient,
  getSandInferenceBackendUrl,
} from "../../../shared/node/cursor-backend/cursor-inference.js";
import { LEGACY_WORKFLOW_FILENAME, parseWorkflowFile } from "../../../shared/workflow-model.js";
import { SandSkillPublishError } from "../../../shared/workflows.js";
import { GlobalWorkflowLibrary, getGlobalWorkflowsDir, type GlobalWorkflowRecord } from "../../workflows/workflow-library.js";
import type { PluginSkillRecord, PluginSkillsCache } from "./plugin-skills-cache.js";

export const PUBLISH_SKILL_RPC_TIMEOUT_MS = 60_000;
export const PUBLISH_TARGETS_RPC_TIMEOUT_MS = 10_000;
export const CONFIRM_PUBLISH_MAX_ATTEMPTS = 5;
export const UNPUBLISHABLE_FILES = new Set([LEGACY_WORKFLOW_FILENAME, "runs.json"]);

export interface SkillPublishClient {
  getTeams(request: GetTeamsRequest, options: { timeoutMs: number }): Promise<{ teams: readonly { id: number; isDirectMember: boolean; name: string }[] }>;
  publishPlugin(request: PublishPluginRequest, options: { timeoutMs: number }): Promise<{ pluginId: string | number | bigint; commitSha: string }>;
  unpublishPlugin(request: UnpublishPluginRequest, options: { timeoutMs: number }): Promise<unknown>;
}
export interface SkillPublishPluginSkills {
  currentIndex(): PluginSkillsCache | null;
  sync(trigger: string): Promise<unknown>;
}
export interface SkillPublishLibrary {
  get(id: string): GlobalWorkflowRecord | null;
  remove(id: string): boolean;
}
export interface SandSkillPublishServiceOptions {
  sandRootDir: string;
  client: SkillPublishClient;
  pluginSkills: SkillPublishPluginSkills;
  library?: SkillPublishLibrary;
  log?(message: string): void;
  reportEdgeFailed?(event: { stage: "list_targets" | "cleanup" | "sync"; errorClass: string }): void;
}
export interface PublishedSkillResult { pluginId: string; commitSha: string }

export function createSandSkillPublishClient(deps: {
  readonly auth: {
    getAccessToken(args: { backendUrl: string }): Promise<string>;
    getMachineId(): Promise<string>;
  };
}): SkillPublishClient {
  return createSandCursorBackendClient(DashboardService, {
    getAccessToken: async () => await deps.auth.getAccessToken({
      backendUrl: getSandInferenceBackendUrl(),
    }),
    getMachineId: deps.auth.getMachineId,
  }) as unknown as SkillPublishClient;
}

export function publishableTeams(response: { teams: readonly { id: number; isDirectMember: boolean; name: string }[] }): Array<{ teamId: number; name: string }> { return response.teams.filter((team) => team.id > 0 && team.isDirectMember).map((team) => ({ teamId: team.id, name: team.name })); }
export async function stageSkillDirForPublish(args: { skillDir: string; targetDir: string }): Promise<string> { const staged = join(args.targetDir, basename(args.skillDir)); await cp(args.skillDir, staged, { recursive: true, dereference: true, filter: (source) => dirname(source) !== args.skillDir || !UNPUBLISHABLE_FILES.has(basename(source)) }); return staged; }
export function readSkillFrontmatter(filePath: string): { name: string; description: string } { let parsed = null; try { parsed = parseWorkflowFile(readFileSync(filePath, "utf8")); } catch {} if (parsed == null) throw new SandSkillPublishError("That skill's file could not be read."); return { name: parsed.name, description: parsed.description }; }
export async function readManifestName(pluginDir: string): Promise<string | null> { try { const manifest = JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf8")) as { name?: unknown }; return typeof manifest.name === "string" && manifest.name.trim() !== "" ? manifest.name : null; } catch { return null; } }
export async function requireManifestName(installPath: string): Promise<string> { const name = await readManifestName(installPath); if (name == null) throw new SandSkillPublishError("Could not read that plugin's manifest, so syncing would risk publishing a duplicate. Reinstall the plugin and try again."); return name; }
export function skillsRootRelativePath(skillRelativePath: string): string { const segments = dirname(skillRelativePath).split(/[/\\]/).filter(Boolean), withoutRoot = segments[0] === "skills" ? segments.slice(1) : segments; if (withoutRoot.length === 0) throw new SandSkillPublishError("That skill sits at a path Sand cannot re-pack."); return withoutRoot.join("/"); }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class SandSkillPublishService {
  readonly library: SkillPublishLibrary;
  constructor(readonly options: SandSkillPublishServiceOptions) {
    this.library = options.library ?? new GlobalWorkflowLibrary(getGlobalWorkflowsDir(options.sandRootDir));
  }

  async listTargets(): Promise<{ teams: Array<{ teamId: number; name: string }>; unavailableReason: string | null }> {
    let response: { teams: readonly { id: number; isDirectMember: boolean; name: string }[] };
    try {
      response = await this.options.client.getTeams(new GetTeamsRequest({ activeOnly: true }), { timeoutMs: PUBLISH_TARGETS_RPC_TIMEOUT_MS });
    } catch (error) {
      this.options.log?.(`[sand:skill-publish] failed to resolve publishable teams: ${errorMessage(error)}`);
      this.options.reportEdgeFailed?.({ stage: "list_targets", errorClass: errorLogTag(error) });
      return { teams: [], unavailableReason: "Could not reach Cursor to check your teams." };
    }
    const teams = publishableTeams(response);
    return { teams, unavailableReason: teams.length > 0 ? null : "Publishing a skill needs a Cursor team. Join or create one, then try again." };
  }

  async publish(args: { workflowId: string; teamId: number }): Promise<PublishedSkillResult & { promotedWorkflowId: string | null }> {
    const record = this.requireLibraryRecord(args.workflowId);
    if (!Number.isInteger(args.teamId) || args.teamId <= 0) throw new SandSkillPublishError("Choose a team to publish this skill to.");
    const published = await this.upload({ skillDir: dirname(record.filePath), skillRelativePath: record.id, name: record.name, description: record.description, teamId: args.teamId, pluginName: record.name });
    const landedId = await this.confirmPublishLanded(published);
    const promotedWorkflowId = landedId != null && this.library.remove(record.id) ? landedId : null;
    if (promotedWorkflowId == null) this.options.log?.(`[sand:skill-publish] kept the library copy of ${record.id}: commit ${published.commitSha} was not confirmed installed`);
    return { ...published, promotedWorkflowId };
  }

  async resync(args: { workflowId: string }): Promise<PublishedSkillResult & { promotedWorkflowId: null }> {
    const { record, teamId } = this.requirePublishedPluginSkill(args.workflowId);
    const parsed = readSkillFrontmatter(record.filePath), name = parsed.name.length > 0 ? parsed.name : record.name;
    const published = await this.upload({ skillDir: dirname(record.filePath), skillRelativePath: skillsRootRelativePath(record.skillRelativePath), name, description: parsed.description, teamId, pluginName: await requireManifestName(record.installPath), displayName: name });
    await this.syncBestEffort();
    return { ...published, promotedWorkflowId: null };
  }

  async unpublish(args: { workflowId: string }): Promise<{ restoredWorkflowId: string | null }> {
    const { record, teamId } = this.requirePublishedPluginSkill(args.workflowId);
    const restoredWorkflowId = await this.restoreToLibrary(record);
    await this.options.client.unpublishPlugin(new UnpublishPluginRequest({ pluginId: BigInt(record.pluginId), teamId }), { timeoutMs: PUBLISH_SKILL_RPC_TIMEOUT_MS });
    await this.syncBestEffort();
    return { restoredWorkflowId };
  }

  async restoreToLibrary(record: PluginSkillRecord): Promise<string | null> {
    const skillsRoot = getGlobalWorkflowsDir(this.options.sandRootDir), skillDir = dirname(record.filePath), libraryId = basename(skillDir);
    if (this.library.get(libraryId) != null) return libraryId;
    const [restored] = await restoreSkillsFromPluginDir({ skillDirs: [skillDir], pluginSkillsRoot: join(record.installPath, "skills"), skillsRoot });
    return restored != null && dirname(restored) === skillsRoot ? basename(restored) : null;
  }

  async upload(args: { skillDir: string; skillRelativePath: string; name: string; description: string; teamId: number; pluginName: string; displayName?: string }): Promise<PublishedSkillResult> {
    if (args.description.trim().length === 0) throw new SandSkillPublishError("Add a description before publishing — it is how teammates and agents know when to use this skill.");
    const workDir = await mkdtemp(join(tmpdir(), "sand-publish-skill-"));
    try {
      const staged = await stageSkillDirForPublish({ skillDir: args.skillDir, targetDir: join(workDir, "staged") });
      const synthesizeArgs: { skills: { dir: string; relativePath: string }[]; targetDir: string; pluginName: string; displayName?: string } = { skills: [{ dir: staged, relativePath: args.skillRelativePath }], targetDir: join(workDir, "plugin"), pluginName: args.pluginName };
      if (args.displayName != null) synthesizeArgs.displayName = args.displayName;
      const pluginDir = await synthesizeSkillPluginDir(synthesizeArgs), manifestName = await readManifestName(pluginDir) ?? args.pluginName, packed = await packPluginArtifact(pluginDir);
      const response = await this.options.client.publishPlugin(new PublishPluginRequest({ teamId: args.teamId, name: manifestName, displayName: args.displayName ?? args.name, description: args.description, pluginTarGz: new Uint8Array(packed) }), { timeoutMs: PUBLISH_SKILL_RPC_TIMEOUT_MS });
      return { pluginId: response.pluginId.toString(), commitSha: response.commitSha };
    } finally {
      try { await rm(workDir, { recursive: true, force: true }); }
      catch (error) { this.options.log?.(`[sand:skill-publish] failed to clean up ${workDir}: ${errorMessage(error)}`); this.options.reportEdgeFailed?.({ stage: "cleanup", errorClass: errorLogTag(error) }); }
    }
  }

  async confirmPublishLanded(published: PublishedSkillResult): Promise<string | null> {
    for (let attempt = 0; attempt < CONFIRM_PUBLISH_MAX_ATTEMPTS; attempt++) {
      await this.syncBestEffort();
      const landed = this.options.pluginSkills.currentIndex()?.skills.find((record) => record.pluginId === published.pluginId && record.pluginVersion === published.commitSha && existsSync(record.filePath));
      if (landed != null) return landed.id;
    }
    return null;
  }

  requireLibraryRecord(workflowId: string): GlobalWorkflowRecord {
    const record = this.library.get(workflowId);
    if (record == null) throw new SandSkillPublishError("That skill no longer exists in your library.");
    return record;
  }

  requirePublishedPluginSkill(workflowId: string): { record: PluginSkillRecord; teamId: number } {
    const index = this.options.pluginSkills.currentIndex(), record = index?.skills.find((candidate) => candidate.id === workflowId);
    if (index == null || record == null) throw new SandSkillPublishError("That skill is no longer installed.");
    if (record.publisherUserId == null || record.publisherUserId !== index.currentUserId) throw new SandSkillPublishError(`"${record.name}" belongs to a plugin you did not publish.`);
    if (record.marketplaceTeamId == null) throw new SandSkillPublishError(`"${record.name}" is not in a team marketplace, so there is nothing to sync it back to.`);
    return { record, teamId: record.marketplaceTeamId };
  }

  async syncBestEffort(): Promise<void> {
    try { await this.options.pluginSkills.sync("install"); }
    catch (error) { this.options.log?.(`[sand:skill-publish] plugin-skills sync after publish failed: ${errorMessage(error)}`); this.options.reportEdgeFailed?.({ stage: "sync", errorClass: errorLogTag(error) }); }
  }
}
