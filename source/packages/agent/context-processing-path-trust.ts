import { realpath } from "node:fs/promises";
import path from "node:path";

import type { Context } from "../context/core.js";
import { createLogger } from "../context/logger.js";

export interface AttachmentPathEnvironment {
  readonly projectFolder?: string | undefined;
  readonly workspacePaths: readonly string[];
  readonly artifactsFolder?: string | undefined;
}

export interface AttachmentPathRequestContext {
  readonly env?: AttachmentPathEnvironment | undefined;
}

export type AttachmentKind = "video" | "document" | string;

export interface TrustedPathOnlyAttachmentResult {
  readonly hasPathOnlyPayload: boolean;
  readonly trustedPath: string | undefined;
}

const logger = createLogger("@anysphere/agent/context-processing");

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed path-trust leaf. The parent processSelectedContext function
// remains absent.
export async function resolveTrustedPathOnlyAttachmentPath(
  ctx: Context,
  readablePath: string,
  requestContext: AttachmentPathRequestContext | undefined,
  attachmentKind: AttachmentKind,
  treatNonAbsoluteAsPathOnly: boolean,
): Promise<TrustedPathOnlyAttachmentResult> {
  const hasPathOnlyPayload = readablePath.length > 0 &&
    (treatNonAbsoluteAsPathOnly || path.isAbsolute(readablePath));
  if (!hasPathOnlyPayload) {
    return { hasPathOnlyPayload: false, trustedPath: undefined };
  }
  const trustedPath = await resolveTrustedPathOnlyAttachmentCandidate({
    readablePath,
    requestContext,
    attachmentKind,
  });
  if (trustedPath === undefined) {
    logger.warn(ctx, `Ignoring untrusted path-only ${attachmentKind} attachment`);
  }
  return { hasPathOnlyPayload: true, trustedPath };
}

function isPathWithinPrefix({ targetPath, prefix }: { targetPath: string; prefix: string }): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedPrefix = path.resolve(prefix);
  return resolvedTarget === resolvedPrefix || resolvedTarget.startsWith(resolvedPrefix + path.sep);
}

function isPathWithinAnyPrefix(targetPath: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => isPathWithinPrefix({ targetPath, prefix }));
}

function isAttachmentStoragePath(targetPath: string, projectFolder: string | undefined): boolean {
  if (projectFolder === undefined) {
    return false;
  }
  if (!isPathWithinPrefix({ targetPath, prefix: projectFolder })) {
    return false;
  }
  const relativePath = path.relative(path.resolve(projectFolder), path.resolve(targetPath));
  const segments = relativePath.split(path.sep).filter(Boolean);
  return segments.length >= 3 && segments[0] === "attachments" &&
    segments[1] !== undefined && segments[2] !== undefined;
}

async function resolveCanonicalAttachmentPath(targetPath: string): Promise<string | undefined> {
  try {
    return await realpath(targetPath);
  } catch {
    return undefined;
  }
}

async function getTrustedSelectedDocumentPath(
  documentPath: string,
  requestContext: AttachmentPathRequestContext | undefined,
): Promise<string | undefined> {
  const canonicalPath = await resolveCanonicalAttachmentPath(documentPath);
  if (canonicalPath === undefined) {
    return undefined;
  }
  const env = requestContext?.env;
  const allowedPrefixes = [
    env?.projectFolder ? path.join(env.projectFolder, "uploads") : undefined,
    ...(env?.workspacePaths.map((workspacePath) => path.join(workspacePath, "uploads")) ?? []),
    env?.artifactsFolder,
  ].filter((prefix): prefix is string => prefix !== undefined);
  const isTrusted = isPathWithinAnyPrefix(canonicalPath, allowedPrefixes) ||
    isAttachmentStoragePath(canonicalPath, env?.projectFolder);
  return isTrusted ? canonicalPath : undefined;
}

async function resolveTrustedPathOnlyAttachmentCandidate({
  readablePath,
  requestContext,
  attachmentKind,
}: {
  readonly readablePath: string;
  readonly requestContext: AttachmentPathRequestContext | undefined;
  readonly attachmentKind: AttachmentKind;
}): Promise<string | undefined> {
  if (!path.isAbsolute(readablePath)) {
    return undefined;
  }
  if (attachmentKind === "video") {
    return path.resolve(readablePath);
  }
  return getTrustedSelectedDocumentPath(readablePath, requestContext);
}
