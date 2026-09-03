import { randomBytes } from "node:crypto";
import { copyFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

function isWindowsReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EEXIST");
}

/**
 * POSIX `rename` replaces an existing file. Windows often returns EPERM instead
 * when Defender or another handle still has the destination open (GitHub's
 * windows-latest runners do this). Unlink-then-rename, then copy as last resort.
 */
export async function replaceFile(fromPath: string, toPath: string): Promise<void> {
  try {
    await rename(fromPath, toPath);
    return;
  } catch (error) {
    if (!isWindowsReplaceError(error)) {
      await unlink(fromPath).catch(() => {});
      throw error;
    }
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await unlink(toPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      await rename(fromPath, toPath);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  try {
    await copyFile(fromPath, toPath);
  } catch (error) {
    lastError = error;
    throw lastError;
  } finally {
    await unlink(fromPath).catch(() => {});
  }
}

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
  await replaceFile(temporaryPath, targetPath);
}
