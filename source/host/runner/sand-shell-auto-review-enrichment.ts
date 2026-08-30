import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { readExecutorResource } from "../../packages/agent-exec/read.js";
import { ReadArgs, type ReadResult } from "../../packages/proto/generated/agent/v1/read_exec_pb.js";

export const SAND_SHELL_ENRICHMENT_MAX_CHARS = 8_000;
export const SAND_SHELL_ENRICHMENT_MAX_LINES = 200;
export const SAND_SHELL_APPROVAL_HASH_CHUNK_LINES = 50;
export const SAND_SHELL_APPROVAL_HASH_MAX_LINES = 20_000;
export const SAND_SHELL_APPROVAL_PARSE_MAX_CHARS = 1_000_000;

export type SandShellEnrichmentCandidate =
  | { readonly kind: "executable"; readonly path: string }
  | {
    readonly kind: "package_script";
    readonly packageJsonPath: string;
    readonly scriptName: string;
  }
  | {
    readonly kind: "package_script_unresolved";
    readonly packageJsonPath?: string;
    readonly invocation: string;
  };

export interface SandShellReadAccessor<Context> {
  get(resource: typeof readExecutorResource): {
    execute(context: Context, args: ReadArgs, options?: unknown): Promise<ReadResult>;
  };
}

export interface BoundedText {
  readonly content: string;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export interface FullTextHash {
  readonly definitionHash: string;
  readonly fullContent?: string;
}

export type SandShellTargetEnrichment =
  | {
    readonly kind: "executable" | "package_script" | "package_script_unresolved";
    readonly path: string;
    readonly approval_binding_unavailable: true;
    readonly approval_binding_nonce: string;
  }
  | {
    readonly kind: "executable";
    readonly path: string;
    readonly definition: string;
    readonly definition_hash: string;
    readonly truncated: boolean;
  }
  | {
    readonly kind: "package_script";
    readonly path: string;
    readonly name: string;
    readonly definition: string;
    readonly definition_hash: string;
    readonly truncated: false;
  };

export function unquote(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"'))
    || (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

export function parseSandShellEnrichmentCandidate(
  command: string,
  workingDirectory?: string,
): SandShellEnrichmentCandidate | undefined {
  let candidateCommand = command.trim();
  let candidateWorkingDirectory = workingDirectory;
  for (let prefixCount = 0; prefixCount < 4; prefixCount += 1) {
    const environmentPrefix = candidateCommand.match(
      /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)+/,
    );
    if (environmentPrefix != null) {
      candidateCommand = candidateCommand.slice(environmentPrefix[0].length);
      continue;
    }
    const changeDirectoryPrefix = candidateCommand.match(
      /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*(.+)$/,
    );
    if (changeDirectoryPrefix == null) break;
    const directoryToken = changeDirectoryPrefix[1];
    const remaining = changeDirectoryPrefix[2];
    if (directoryToken == null || remaining == null) break;
    candidateWorkingDirectory = candidateWorkingDirectory == null
      ? undefined
      : resolve(candidateWorkingDirectory, unquote(directoryToken));
    candidateCommand = remaining;
  }

  const commandSegments = candidateCommand
    .split(/[;&|\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (commandSegments.length > 1) {
    const hasPackageManagerSegment = commandSegments.some((segment) => {
      const nested = parseSandShellEnrichmentCandidate(segment, candidateWorkingDirectory);
      return nested?.kind === "package_script" || nested?.kind === "package_script_unresolved";
    });
    if (hasPackageManagerSegment) {
      return {
        kind: "package_script_unresolved",
        ...(candidateWorkingDirectory == null
          ? {}
          : { packageJsonPath: resolve(candidateWorkingDirectory, "package.json") }),
        invocation: candidateCommand,
      };
    }
  }

  const packageMatch = candidateCommand.match(
    /^(?:npm(?:\s+run)?|pnpm(?:\s+run)?|yarn(?:\s+run)?)\s+([A-Za-z0-9_:][A-Za-z0-9:_-]*)(?:\s|$)/,
  );
  if (packageMatch != null) {
    const scriptName = packageMatch[1];
    if (scriptName == null) return undefined;
    if (candidateWorkingDirectory == null) {
      return { kind: "package_script_unresolved", invocation: packageMatch[0].trim() };
    }
    return {
      kind: "package_script",
      packageJsonPath: resolve(candidateWorkingDirectory, "package.json"),
      scriptName,
    };
  }
  const unresolvedPackageMatch = candidateCommand.match(/^(?:npm|pnpm|yarn)\s+[^;&|]+/);
  if (unresolvedPackageMatch != null) {
    return {
      kind: "package_script_unresolved",
      ...(candidateWorkingDirectory == null
        ? {}
        : { packageJsonPath: resolve(candidateWorkingDirectory, "package.json") }),
      invocation: unresolvedPackageMatch[0],
    };
  }
  if (/\b(?:npm|pnpm|yarn)\b/.test(candidateCommand)) {
    return {
      kind: "package_script_unresolved",
      ...(candidateWorkingDirectory == null
        ? {}
        : { packageJsonPath: resolve(candidateWorkingDirectory, "package.json") }),
      invocation: candidateCommand,
    };
  }

  const interpreterMatch = candidateCommand.match(
    /^(?:python(?:3(?:\.\d+)?)?|node|bash|sh|zsh)\s+("[^"]+"|'[^']+'|[^\s;&|]+)(?:\s|$)/,
  );
  const directMatch = candidateCommand.match(
    /^((?:\/|\.{1,2}\/)("[^"]+"|'[^']+'|[^\s;&|]+)|(?:\/|\.{1,2}\/)[^\s;&|]+)(?:\s|$)/,
  );
  const token = interpreterMatch?.[1] ?? directMatch?.[1];
  if (token == null) return undefined;
  const executablePath = unquote(token);
  if (isAbsolute(executablePath)) return { kind: "executable", path: executablePath };
  return candidateWorkingDirectory == null
    ? undefined
    : { kind: "executable", path: resolve(candidateWorkingDirectory, executablePath) };
}

function successfulTextRead(result: ReadResult): {
  readonly content: string;
  readonly totalLines: number;
  readonly truncated: boolean;
} | undefined {
  if (result.result.case !== "success") return undefined;
  const value = result.result.value;
  const output = value.output;
  if (output.case !== "content") return undefined;
  return {
    content: output.value,
    totalLines: value.totalLines,
    truncated: value.truncated,
  };
}

export async function readBoundedText<Context>(
  context: Context,
  resourceAccessor: SandShellReadAccessor<Context>,
  path: string,
  toolCallId: string,
): Promise<BoundedText | undefined> {
  const parsed = successfulTextRead(await resourceAccessor.get(readExecutorResource).execute(
    context,
    new ReadArgs({
      path,
      toolCallId,
      offset: 1,
      limit: SAND_SHELL_ENRICHMENT_MAX_LINES,
    }),
  ));
  if (parsed == null) return undefined;
  return {
    content: parsed.content.slice(0, SAND_SHELL_ENRICHMENT_MAX_CHARS),
    totalLines: parsed.totalLines,
    truncated: parsed.truncated
      || parsed.content.length > SAND_SHELL_ENRICHMENT_MAX_CHARS
      || parsed.totalLines > SAND_SHELL_ENRICHMENT_MAX_LINES,
  };
}

export async function hashFullText<Context>(
  context: Context,
  resourceAccessor: SandShellReadAccessor<Context>,
  path: string,
  toolCallId: string,
  totalLines: number,
): Promise<FullTextHash | undefined> {
  if (totalLines > SAND_SHELL_APPROVAL_HASH_MAX_LINES) return undefined;
  const hash = createHash("sha256");
  let fullContent = "";
  let canRetainFullContent = true;
  for (
    let offset = 1;
    offset <= Math.max(1, totalLines);
    offset += SAND_SHELL_APPROVAL_HASH_CHUNK_LINES
  ) {
    const parsed = successfulTextRead(await resourceAccessor.get(readExecutorResource).execute(
      context,
      new ReadArgs({
        path,
        toolCallId,
        offset,
        limit: SAND_SHELL_APPROVAL_HASH_CHUNK_LINES,
      }),
    ));
    if (parsed == null || parsed.truncated) return undefined;
    hash.update(String(offset)).update("\0").update(parsed.content).update("\0");
    if (
      canRetainFullContent
      && fullContent.length + parsed.content.length <= SAND_SHELL_APPROVAL_PARSE_MAX_CHARS
    ) {
      fullContent += parsed.content;
    } else {
      canRetainFullContent = false;
      fullContent = "";
    }
  }
  return {
    definitionHash: hash.digest("hex"),
    ...(canRetainFullContent ? { fullContent } : {}),
  };
}

export function unavailableBinding(
  candidate: SandShellEnrichmentCandidate,
): SandShellTargetEnrichment {
  return {
    kind: candidate.kind,
    path: candidate.kind === "executable"
      ? candidate.path
      : candidate.kind === "package_script"
        ? candidate.packageJsonPath
        : candidate.packageJsonPath ?? candidate.invocation,
    approval_binding_unavailable: true,
    approval_binding_nonce: randomUUID(),
  };
}

export async function buildSandShellAutoReviewTargetEnrichment<Context>(
  context: Context,
  args: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly resourceAccessor: SandShellReadAccessor<Context>;
    readonly toolCallId: string;
  },
): Promise<SandShellTargetEnrichment | undefined> {
  const candidate = parseSandShellEnrichmentCandidate(args.command, args.workingDirectory);
  if (candidate == null) return undefined;
  if (candidate.kind === "package_script_unresolved") return unavailableBinding(candidate);
  try {
    const path = candidate.kind === "executable" ? candidate.path : candidate.packageJsonPath;
    const read = await readBoundedText(context, args.resourceAccessor, path, args.toolCallId);
    if (read == null) return unavailableBinding(candidate);
    const full = await hashFullText(
      context,
      args.resourceAccessor,
      path,
      args.toolCallId,
      read.totalLines,
    );
    if (full == null) return unavailableBinding(candidate);
    if (candidate.kind === "executable") {
      if (read.truncated) return unavailableBinding(candidate);
      return {
        kind: "executable",
        path: candidate.path,
        definition: read.content,
        definition_hash: full.definitionHash,
        truncated: read.truncated,
      };
    }
    const parsed = JSON.parse(full.fullContent ?? read.content) as {
      readonly scripts?: Readonly<Record<string, unknown>>;
    };
    const body = parsed.scripts?.[candidate.scriptName];
    if (typeof body !== "string" || body.length > SAND_SHELL_ENRICHMENT_MAX_CHARS) {
      return unavailableBinding(candidate);
    }
    return {
      kind: "package_script",
      path: candidate.packageJsonPath,
      name: candidate.scriptName,
      definition: body.slice(0, SAND_SHELL_ENRICHMENT_MAX_CHARS),
      definition_hash: full.definitionHash,
      truncated: false,
    };
  } catch {
    return unavailableBinding(candidate);
  }
}
