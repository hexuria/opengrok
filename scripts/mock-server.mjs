import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(repoRoot, ".build");
const outfile = path.join(outdir, "mock-server.mjs");

await mkdir(outdir, { recursive: true });
await build({
  entryPoints: [path.join(repoRoot, "source/mock/cli.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  logLevel: "warning",
});

const { startMockServerCli } = await import(pathToFileURL(outfile).href);
await startMockServerCli();
