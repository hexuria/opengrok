import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create } from "tar";

export async function packPluginArtifact(dirPath: string): Promise<Buffer> {
  const archivePath = join(
    await mkdtemp(join(tmpdir(), "cursor-plugin-artifact-")),
    "plugin.tgz",
  );
  try {
    const entries = await readdir(dirPath);
    await create({
      cwd: dirPath,
      file: archivePath,
      gzip: true,
      portable: true,
      filter: (_path, stat) => !(
        stat as { isSymbolicLink?: () => boolean }
      ).isSymbolicLink?.(),
    }, entries);
    return await readFile(archivePath);
  } finally {
    await rm(dirname(archivePath), { recursive: true, force: true }).catch(
      () => {},
    );
  }
}
