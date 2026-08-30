import { access } from "node:fs/promises";
import { join } from "node:path";
import { execGitNonInteractive, type ExecGitNonInteractiveOptions } from "./git-subprocess-env.js";
import { MARKETPLACE_MANIFEST_PATHS } from "./manifest-parser.js";

const DISABLE_SPARSE_PLUGIN_CLONES_ENV = "CURSOR_DISABLE_SPARSE_PLUGIN_CLONES";
const ALWAYS_SPARSE_DIRS = MARKETPLACE_MANIFEST_PATHS.map(path => path.split("/")[0]!);
const MIN_SPARSE_GIT = { major: 2, minor: 26 };
let sparseSupportPromise: Promise<boolean> | undefined;

function parseGitVersion(stdout: string): { major: number; minor: number } | null {
  const match = /git version (\d+)\.(\d+)/.exec(stdout);
  return match === null ? null : { major: Number(match[1]), minor: Number(match[2]) };
}

async function isSparseCloneSupported(): Promise<boolean> {
  if (process.env[DISABLE_SPARSE_PLUGIN_CLONES_ENV]) return false;
  sparseSupportPromise ??= (async () => {
    try {
      const { stdout } = await execGitNonInteractive(["--version"]);
      const version = parseGitVersion(stdout);
      return version !== null && (version.major > MIN_SPARSE_GIT.major || version.major === MIN_SPARSE_GIT.major && version.minor >= MIN_SPARSE_GIT.minor);
    } catch { return false; }
  })();
  return sparseSupportPromise;
}

function normalizeSparseCheckoutDir(dir: string): string | null {
  let normalized = dir.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/, "");
  if (normalized === "" || normalized === "." || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  const segments = normalized.split("/");
  return segments.some(segment => segment === "" || segment === "." || segment === "..") ? null : normalized;
}

export type MaterializeSpec = "all" | string[];
export function materializeSpecForGitPaths(gitPaths: readonly string[]): MaterializeSpec {
  const dirs: string[] = [];
  for (const gitPath of gitPaths) {
    const normalized = normalizeSparseCheckoutDir(gitPath);
    if (normalized === null) return "all";
    dirs.push(normalized);
  }
  return dirs;
}

function sparseDirsForInitialCheckout(dirs: readonly string[]): string[] { return [...new Set([...ALWAYS_SPARSE_DIRS, ...dirs])]; }

export async function resolveSparseClonePlan(
  requested: MaterializeSpec,
  sparsePluginClones: boolean,
): Promise<{ materialize: MaterializeSpec; sparse: boolean; sparseDirs: string[] }> {
  const materialize = requested === "all" ? "all" : materializeSpecForGitPaths(requested);
  const sparse = sparsePluginClones && materialize !== "all" && await isSparseCloneSupported();
  return { materialize, sparse, sparseDirs: sparse ? sparseDirsForInitialCheckout(materialize) : [] };
}

export function serverIgnoredFilter(stderr: string): boolean { return stderr.toLowerCase().includes("filtering not recognized by server"); }

export async function setSparseCheckoutDirs(
  repoDir: string,
  dirs: readonly string[],
  execOpts?: ExecGitNonInteractiveOptions,
): Promise<void> {
  await execGitNonInteractive(["sparse-checkout", "set", "--cone", "--", ...dirs], { ...execOpts, cwd: repoDir });
}

export async function isSparseCheckoutRepo(repoDir: string): Promise<boolean> {
  try { await access(join(repoDir, ".git", "info", "sparse-checkout")); }
  catch { return false; }
  try {
    const { stdout } = await execGitNonInteractive(["config", "--bool", "--get", "core.sparseCheckout"], { cwd: repoDir });
    return stdout.trim() === "true";
  } catch { return false; }
}

export async function materializeSparseDirs(
  repoDir: string,
  spec: MaterializeSpec,
  execOpts?: ExecGitNonInteractiveOptions,
): Promise<void> {
  if (spec !== "all" && spec.length === 0) return;
  if (!await isSparseCheckoutRepo(repoDir)) return;
  const gitOpts: ExecGitNonInteractiveOptions = { ...execOpts, cwd: repoDir, sshBatchMode: true };
  if (spec === "all") {
    await execGitNonInteractive(["sparse-checkout", "disable"], gitOpts);
    return;
  }
  const dirs = materializeSpecForGitPaths(spec);
  if (dirs === "all") {
    await execGitNonInteractive(["sparse-checkout", "disable"], gitOpts);
    return;
  }
  await execGitNonInteractive(["sparse-checkout", "add", "--", ...dirs], gitOpts);
}
