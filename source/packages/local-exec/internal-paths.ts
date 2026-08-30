import { homedir } from "node:os";
import { join } from "node:path";
export const CURSOR_PROJECTS_ROOT = join(homedir(), ".cursor", "projects");
export const CURSOR_WORKTREES_ROOT = join(homedir(), ".cursor", "worktrees");
