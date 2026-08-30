import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RestoreSkillsFromPluginDirOptions {
  readonly skillDirs: readonly string[];
  readonly pluginSkillsRoot: string;
  readonly skillsRoot: string;
}

export async function restoreSkillsFromPluginDir(
  options: RestoreSkillsFromPluginDirOptions,
): Promise<string[]> {
  const { skillDirs, pluginSkillsRoot, skillsRoot } = options;
  if (skillDirs.length === 0) {
    throw new Error("At least one skill directory is required");
  }

  const restores = skillDirs.map(skillDir => {
    const relativePath = relative(
      resolve(pluginSkillsRoot),
      resolve(skillDir),
    );
    if (
      relativePath === ""
      || isAbsolute(relativePath)
      || relativePath.split(sep)[0] === ".."
    ) {
      throw new Error(
        `Skill folder "${skillDir}" is not inside the plugin's skills directory`,
      );
    }
    return { skillDir, target: join(skillsRoot, relativePath) };
  });

  const duplicates = restores
    .map(({ target }) => target)
    .filter((target, index, targets) => targets.indexOf(target) !== index);
  if (duplicates.length > 0) {
    throw new Error(
      `Multiple skill folders would restore to the same path: ${duplicates.join(", ")}`,
    );
  }

  for (const { skillDir, target } of restores) {
    if (!await isDirectory(skillDir)) {
      throw new Error(`Skill folder "${skillDir}" is not a directory`);
    }
    if (await pathExists(target)) {
      throw new Error(
        `Cannot restore skill to "${target}": that path already exists`,
      );
    }
  }

  await mkdir(skillsRoot, { recursive: true });
  for (const { skillDir, target } of restores) {
    await mkdir(dirname(target), { recursive: true });
    await cp(skillDir, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  return restores.map(({ target }) => target);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
