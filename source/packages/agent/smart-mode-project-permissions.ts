import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseProjectPermissionsFileConfig } from "../cursor-config/project-permissions-file-provider.js";

const MAX_PROJECT_PERMISSION_INSTRUCTIONS_PER_WORKSPACE = 20;
const MAX_USER_AUTO_RUN_INSTRUCTIONS = 20;
const MAX_PROJECT_PERMISSION_INSTRUCTION_CHARS = 1e3;
const PROJECT_PERMISSIONS_FILE_NAME = ".cursor/permissions.json";

interface AutoRunInstructions {
  readonly allowInstructions: readonly string[];
  readonly blockInstructions: readonly string[];
}

export interface SmartModeProjectPermissionsContext {
  readonly auto_run: {
    readonly allow_instructions: string[];
    readonly block_instructions: string[];
  };
  readonly truncated: boolean;
}

function truncateInstruction(instruction: string): { value: string; truncated: boolean } {
  if (instruction.length <= MAX_PROJECT_PERMISSION_INSTRUCTION_CHARS) {
    return { value: instruction, truncated: false };
  }
  return {
    value: `${instruction.slice(0, MAX_PROJECT_PERMISSION_INSTRUCTION_CHARS)}
...[truncated]`,
    truncated: true,
  };
}

function truncateInstructions(
  instructions: readonly string[],
  maxCount: number,
): { values: string[]; truncated: boolean } {
  const sliced = instructions.slice(0, maxCount);
  let truncated = sliced.length < instructions.length || instructions.some(instruction => instruction.length > MAX_PROJECT_PERMISSION_INSTRUCTION_CHARS);
  const values = sliced.map(instruction => {
    const result = truncateInstruction(instruction);
    truncated ||= result.truncated;
    return result.value;
  });
  return { values, truncated };
}

function appendUniqueInstructions(target: string[], instructions: readonly string[]): void {
  const seen = new Set(target);
  for (const instruction of instructions) {
    if (seen.has(instruction)) continue;
    seen.add(instruction);
    target.push(instruction);
  }
}

function appendUniqueInstructionsExcluding(
  target: string[],
  instructions: readonly string[],
  excludedInstructions: readonly string[],
): void {
  const seen = new Set([...excludedInstructions, ...target]);
  for (const instruction of instructions) {
    if (seen.has(instruction)) continue;
    seen.add(instruction);
    target.push(instruction);
  }
}

function hasAnyAutoRunInstructions(instructions: AutoRunInstructions | undefined): boolean {
  return instructions !== undefined && (instructions.allowInstructions.length > 0 || instructions.blockInstructions.length > 0);
}

export async function loadSmartModeProjectPermissionsContext(
  _ctx: unknown,
  workspacePaths: readonly string[] | undefined,
  userAutoRunInstructions: AutoRunInstructions | undefined,
  projectAutoRunInstructions: AutoRunInstructions | undefined,
): Promise<SmartModeProjectPermissionsContext | undefined> {
  const candidatePathSet = new Set<string>();
  if (workspacePaths !== undefined) {
    for (const workspacePath of workspacePaths) {
      if (typeof workspacePath !== "string") continue;
      const trimmed = workspacePath.trim();
      if (trimmed.length === 0) continue;
      candidatePathSet.add(join(trimmed, PROJECT_PERMISSIONS_FILE_NAME));
    }
  }
  const projectAllowInstructionsAggregate: string[] = [];
  const projectBlockInstructionsAggregate: string[] = [];
  let foundAnyPermissionsFile = hasAnyAutoRunInstructions(projectAutoRunInstructions);
  if (hasAnyAutoRunInstructions(projectAutoRunInstructions)) {
    appendUniqueInstructions(projectAllowInstructionsAggregate, projectAutoRunInstructions!.allowInstructions);
    appendUniqueInstructions(projectBlockInstructionsAggregate, projectAutoRunInstructions!.blockInstructions);
  } else {
    for (const filePath of candidatePathSet) {
      if (!existsSync(filePath)) continue;
      try {
        const raw = await readFile(filePath, "utf8");
        const config = parseProjectPermissionsFileConfig(raw);
        if (config === undefined) continue;
        foundAnyPermissionsFile = true;
        if (config.autoRun?.allowInstructions !== undefined) {
          appendUniqueInstructions(projectAllowInstructionsAggregate, config.autoRun.allowInstructions);
        }
        if (config.autoRun?.blockInstructions !== undefined) {
          appendUniqueInstructions(projectBlockInstructionsAggregate, config.autoRun.blockInstructions);
        }
      } catch {
      }
    }
  }
  const userAllowInstructionsAggregate: string[] = [];
  const userBlockInstructionsAggregate: string[] = [];
  if (hasAnyAutoRunInstructions(userAutoRunInstructions)) {
    appendUniqueInstructionsExcluding(userAllowInstructionsAggregate, userAutoRunInstructions!.allowInstructions, projectAllowInstructionsAggregate);
    appendUniqueInstructionsExcluding(userBlockInstructionsAggregate, userAutoRunInstructions!.blockInstructions, projectBlockInstructionsAggregate);
  }
  if (!foundAnyPermissionsFile && !hasAnyAutoRunInstructions(userAutoRunInstructions)) return undefined;
  const workspaceCount = Math.max(workspacePaths?.length ?? 1, 1);
  const maxProjectInstructions = MAX_PROJECT_PERMISSION_INSTRUCTIONS_PER_WORKSPACE * workspaceCount;
  const projectAllowInstructions = truncateInstructions(projectAllowInstructionsAggregate, maxProjectInstructions);
  const projectBlockInstructions = truncateInstructions(projectBlockInstructionsAggregate, maxProjectInstructions);
  const userAllowInstructions = truncateInstructions(userAllowInstructionsAggregate, MAX_USER_AUTO_RUN_INSTRUCTIONS);
  const userBlockInstructions = truncateInstructions(userBlockInstructionsAggregate, MAX_USER_AUTO_RUN_INSTRUCTIONS);
  return {
    auto_run: {
      allow_instructions: [...projectAllowInstructions.values, ...userAllowInstructions.values],
      block_instructions: [...projectBlockInstructions.values, ...userBlockInstructions.values],
    },
    truncated: projectAllowInstructions.truncated || projectBlockInstructions.truncated || userAllowInstructions.truncated || userBlockInstructions.truncated,
  };
}
