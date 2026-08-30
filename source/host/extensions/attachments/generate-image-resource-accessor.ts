import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { getAgentAssetsDir, getAgentMediaStoreRoots } from "../../attachment-paths.js";
import { containWithin } from "../../../shared/node/paths.js";

export type GenerateImageResourceResult =
  | { readonly result: { readonly case: "success"; readonly value: { readonly path?: string; readonly fileSize?: number; readonly data?: Uint8Array } } }
  | { readonly result: { readonly case: "error"; readonly value: { readonly path?: string; readonly error: string } } };
export interface GenerateImageResourceAccessor {
  readonly write: (args: { readonly path: string; readonly fileBytes: Uint8Array }) => Promise<GenerateImageResourceResult>;
  readonly read: (args: { readonly path: string }) => Promise<GenerateImageResourceResult>;
}
export function createSandGenerateImageResourceAccessor(agentDir: string): GenerateImageResourceAccessor {
  const assetsDir = getAgentAssetsDir(agentDir);
  return {
    async write(args) {
      const target = await containWithin([assetsDir], args.path);
      if (target == null) return { result: { case: "error", value: { error: "Refused to write the generated image outside the agent's media store." } } };
      const bytes = Buffer.from(args.fileBytes); await fs.mkdir(dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
      return { result: { case: "success", value: { path: target, fileSize: bytes.length } } };
    },
    async read(args) {
      const resolved = await containWithin(getAgentMediaStoreRoots(agentDir), args.path);
      if (resolved == null) return { result: { case: "error", value: { path: args.path, error: "Refused to read a reference image outside the agent's sandboxed media store." } } };
      try { return { result: { case: "success", value: { data: new Uint8Array(await fs.readFile(resolved)) } } }; }
      catch (error) { return { result: { case: "error", value: { path: args.path, error: error instanceof Error ? error.message : String(error) } } }; }
    }
  };
}
