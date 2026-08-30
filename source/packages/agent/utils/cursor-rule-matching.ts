import path from "node:path";

import { normalizeToUnixPath } from "../../utils/path-utils.js";

interface CursorRulePathInput {
  readonly fullPath?: string | undefined;
  readonly type?: {
    readonly type: {
      readonly case?: string | undefined;
    };
  } | undefined;
}

const SEP = "/";

const normalizePath = (value: string): string => {
  const normalized = path.posix.normalize(normalizeToUnixPath(value));
  if (normalized === SEP) {
    return SEP;
  }
  return normalized.replace(/\/+$/, "");
};

function getRuleDir(mdcPath: string): string {
  const normalizedPath = normalizeToUnixPath(mdcPath);
  const literalRuleDir = path.posix.normalize(path.posix.dirname(normalizedPath));
  const segments = literalRuleDir.split(SEP);
  for (let index = segments.length - 2; index >= 0; index--) {
    if (segments[index] === ".cursor" && segments[index + 1] === "rules") {
      const parentSegments = segments.slice(0, index);
      if (parentSegments.length === 0) {
        return SEP;
      }
      return parentSegments.join(SEP);
    }
  }
  return literalRuleDir;
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return normalizePath(workspaceRoot);
}

function isNestedGlobalRule(rule: CursorRulePathInput, workspacePaths: readonly string[]): boolean {
  if (rule.type?.type.case !== "global" || !rule.fullPath) {
    return false;
  }
  const ruleDir = normalizePath(getRuleDir(rule.fullPath));
  const containingWorkspaceRoot = workspacePaths
    .map(normalizeWorkspaceRoot)
    .find((workspaceRoot) => isPathWithinDir(ruleDir, workspaceRoot));
  if (!containingWorkspaceRoot) {
    return false;
  }
  return ruleDir !== containingWorkspaceRoot;
}

// Extracted from ../packages/agent/dist/utils/cursor-rule-matching.js as an
// uncomposed leaf. The parent user-info and rule-matching consumers remain absent.
export function isFileScopedCursorRule(
  rule: CursorRulePathInput,
  workspacePaths: readonly string[],
): boolean {
  if (rule.type?.type.case === "fileGlobbed") {
    return true;
  }
  if (rule.type?.type.case !== "global") {
    return false;
  }
  return isNestedGlobalRule(rule, workspacePaths);
}

function isPathWithinDir(pathValue: string, dir: string): boolean {
  const normalizedDir = normalizePath(dir);
  if (normalizedDir === SEP) {
    return pathValue.startsWith(SEP);
  }
  return pathValue === normalizedDir || pathValue.startsWith(`${normalizedDir}/`);
}
