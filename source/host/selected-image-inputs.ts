import { readFile } from "node:fs/promises";
import { imageMimeFromPath } from "../shared/media/image-mime.js";
export interface SelectedImageInput { data: Uint8Array<ArrayBuffer>; path: string; mimeType: string | undefined }
export async function loadSelectedImageInputs(attachmentPaths: readonly string[]): Promise<SelectedImageInput[]> {
  if (attachmentPaths.length === 0) return [];
  const loaded = await Promise.all(attachmentPaths.map(async (path): Promise<SelectedImageInput | null> => {
    try {
      const file = await readFile(path);
      const data = Uint8Array.from(file);
      return { data, path, mimeType: imageMimeFromPath(path) };
    } catch {
      return null;
    }
  }));
  return loaded.filter((image): image is SelectedImageInput => image !== null);
}
