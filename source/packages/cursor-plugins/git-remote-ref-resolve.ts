import { execGitNonInteractive, type ExtraGitConfig } from "./git-subprocess-env.js";

const SHA_REF_REGEX = /^[0-9a-f]{7,40}$/i;
const FULL_SHA_REGEX = /^[0-9a-f]{40}$/i;

function parseResolvedCommitSha(stdout: string | undefined): string | undefined {
  if (stdout === undefined || stdout === "") return undefined;
  const shaLines = stdout.split(/\r?\n/).map(line => {
    const [sha, refName] = line.split("\t");
    return !sha || !refName || !/^[0-9a-f]{40}$/i.test(sha) ? undefined : { sha, refName };
  }).filter((line): line is { sha: string; refName: string } => line !== undefined);
  if (shaLines.length === 0) return undefined;
  return shaLines.find(line => line.refName.endsWith("^{}"))?.sha ?? shaLines[0]!.sha;
}

export interface ResolveGitRemoteRefOptions {
  readonly sshBatchMode?: boolean | undefined;
  readonly extraGitConfig?: ExtraGitConfig | undefined;
  readonly timeoutMs?: number | undefined;
}

async function resolveExactRemoteNamedHexRef(
  gitUrl: string,
  ref: string,
  options?: ResolveGitRemoteRefOptions,
): Promise<string | undefined> {
  const { stdout } = await execGitNonInteractive(
    ["ls-remote", gitUrl, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`],
    options,
  );
  return parseResolvedCommitSha(stdout)?.toLowerCase();
}

export async function resolveGitRemoteRef(
  gitUrl: string,
  ref: string,
  options?: ResolveGitRemoteRefOptions,
): Promise<{ fullSha: string; headSymrefStdout?: string }> {
  const normalizedRef = ref.trim();
  if (FULL_SHA_REGEX.test(normalizedRef)) return { fullSha: normalizedRef.toLowerCase() };
  if (SHA_REF_REGEX.test(normalizedRef)) {
    try {
      const namedRefSha = await resolveExactRemoteNamedHexRef(gitUrl, normalizedRef, options);
      if (namedRefSha) return { fullSha: namedRefSha };
    } catch {}
    return { fullSha: normalizedRef.toLowerCase() };
  }

  let stdout: string;
  try {
    if (normalizedRef.toUpperCase() === "HEAD") {
      const result = await execGitNonInteractive(["ls-remote", "--symref", gitUrl, "HEAD"], options);
      const commitSha = parseResolvedCommitSha(result.stdout);
      if (!commitSha) throw new Error(`git ls-remote did not return a resolvable commit for HEAD (${gitUrl})`);
      return { fullSha: commitSha.toLowerCase(), headSymrefStdout: result.stdout };
    }
    ({ stdout } = await execGitNonInteractive(["ls-remote", gitUrl, normalizedRef], options));
  } catch (error) {
    const wrappedError = new Error(
      `Failed to resolve git ref "${normalizedRef}" for ${gitUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
    wrappedError.cause = error;
    throw wrappedError;
  }
  const commitSha = parseResolvedCommitSha(stdout);
  if (!commitSha) throw new Error(`git ls-remote did not return a resolvable commit for ref "${normalizedRef}" (${gitUrl})`);
  return { fullSha: commitSha.toLowerCase() };
}
