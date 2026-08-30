import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { normalizeMarketplaceName } from "./manifest-parser.js";

export interface SynthesizeSkillPluginDirOptions {
  readonly skills: readonly {
    readonly dir: string;
    readonly relativePath: string;
  }[];
  readonly targetDir: string;
  readonly pluginName: string;
  readonly displayName?: string;
}

function skillPathSegments(relativePath: string): string[] {
  if (isAbsolute(relativePath)) {
    throw new Error(
      `Skill path "${relativePath}" must be relative to the skills root`,
    );
  }
  const segments = relativePath
    .split(/[/\\]/)
    .filter(segment => segment.length > 0);
  if (
    segments.length === 0
    || segments.some(segment => segment === "." || segment === "..")
  ) {
    throw new Error(`Skill path "${relativePath}" resolves to an unsafe path`);
  }
  return segments;
}

export async function synthesizeSkillPluginDir(
  options: SynthesizeSkillPluginDirOptions,
): Promise<string> {
  const { skills, targetDir, pluginName } = options;
  if (skills.length === 0) {
    throw new Error("At least one skill directory is required");
  }
  const safeName = normalizeMarketplaceName(pluginName);
  if (safeName === "") {
    throw new Error(`Plugin name "${pluginName}" has no usable characters`);
  }

  const placements = skills.map(({ dir, relativePath }) => {
    const segments = skillPathSegments(relativePath);
    return {
      dir,
      segments,
      manifestPath: `skills/${segments.join("/")}`,
    };
  });
  const duplicates = placements
    .map(({ manifestPath }) => manifestPath)
    .filter((path, index, paths) => paths.indexOf(path) !== index);
  if (duplicates.length > 0) {
    throw new Error(
      `Multiple skill folders would pack to the same path: ${duplicates.join(", ")}`,
    );
  }

  const pluginDir = join(targetDir, safeName);
  const skillsRoot = join(pluginDir, "skills");
  await mkdir(skillsRoot, { recursive: true });
  for (const { dir, segments } of placements) {
    const destination = join(skillsRoot, ...segments);
    await mkdir(dirname(destination), { recursive: true });
    await cp(dir, destination, { recursive: true, dereference: true });
  }

  const manifest = {
    name: safeName,
    displayName: options.displayName ?? pluginName,
    skills: placements.map(({ manifestPath }) => manifestPath),
  };
  await writeFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
  return pluginDir;
}
