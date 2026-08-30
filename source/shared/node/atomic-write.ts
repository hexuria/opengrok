import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writeFileAtomic(targetPath: string, data: Uint8Array | string, options: { readonly mode?: number } = {}): Promise<void> {
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(targetPath)}.${randomBytes(8).toString("hex")}.part`);
  const handle = await open(temporaryPath, "wx", options.mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  await handle.close();
  try { await rename(temporaryPath, targetPath); }
  catch (error) { await unlink(temporaryPath).catch(() => {}); throw error; }
}
