/**
 * Message ⋯ more-menu chrome: match Grok Bot, not the hover toolbar chips.
 *
 * frontend/ is restored from stow and is not tracked here. These transforms
 * run after restore (and again before the Vite packager) so the public repo
 * can own the fix without committing recovered files.
 *
 * The menu rows reuse `.sand-message-hover-actions__button`, the same class as
 * the 24×24 icon-only chips on the hover bar. That class has no icon/label
 * gap, 14px secondary type, and a translucent ghost hover. The panel itself
 * paints `--cursor-bg-elevated`, which reads as glass over the bubble. Official
 * Grok Bot's more-menu is an opaque elevated surface with roster/ui-menu row
 * geometry. These rules are scoped under `.sand-message-more-menu` so the
 * toolbar chips stay 24×24 ghosts.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");

export const MESSAGE_MORE_MENU_FIX_MARK = "sand-message-more-menu-fix";

/**
 * Specificity `:not(#\#)` beats the recovered view.css rules and StyleX atoms
 * regardless of stylesheet order. Every hover-actions button selector is
 * nested under `.sand-message-more-menu` so the 24×24 toolbar chips are
 * untouched.
 */
export const MESSAGE_MORE_MENU_CSS = `/* ${MESSAGE_MORE_MENU_FIX_MARK}: opaque Grok Bot more-menu, not toolbar chips */
.sand-message-more-menu:not(#\\#):not(#\\#) {
  min-width: 180px;
  padding: 4px;
  background: var(--sand-bg-elevated, Canvas);
  border: 1px solid var(--cursor-stroke-secondary);
  border-radius: 8px;
  box-shadow: var(--cursor-box-shadow-md, 0 12px 28px rgba(0, 0, 0, .35));
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  color: var(--cursor-text-primary);
}
.sand-message-more-menu:not(#\\#):not(#\\#) .sand-message-hover-actions__button {
  display: flex;
  width: 100%;
  height: auto;
  min-height: 30px;
  padding: 0 8px;
  justify-content: flex-start;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 6px;
  font-size: 13px;
  line-height: 18px;
  font-weight: var(--sand-font-weight-regular, 420);
  color: var(--cursor-text-primary);
  background: transparent;
  white-space: nowrap;
  text-align: left;
  box-sizing: border-box;
}
.sand-message-more-menu:not(#\\#):not(#\\#) .sand-message-hover-actions__button:hover:not(:disabled) {
  background: var(--cursor-bg-hover, var(--cursor-bg-secondary));
}
.sand-message-more-menu:not(#\\#):not(#\\#) .ui-icon:not(#\\#):not(#\\#) {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
`;

export function patchProductionCss(source) {
  if (source.includes(MESSAGE_MORE_MENU_FIX_MARK)) return source;
  const trimmed = source.endsWith("\n") ? source : `${source}\n`;
  return `${trimmed}\n${MESSAGE_MORE_MENU_CSS}`;
}

/**
 * Append the same override next to the recovered more-menu rules. Later
 * equal-specificity declarations in this file would still lose to atoms;
 * the `:not(#\#)` bump is what actually wins.
 */
export function patchWorkspaceViewCss(source) {
  if (source.includes(MESSAGE_MORE_MENU_FIX_MARK)) return source;
  if (!source.includes(".sand-message-more-menu")) return source;
  const trimmed = source.endsWith("\n") ? source : `${source}\n`;
  return `${trimmed}\n${MESSAGE_MORE_MENU_CSS}`;
}

async function patchFile(root, relative, transform) {
  const file = path.join(root, relative);
  if (!existsSync(file)) return { file: relative, changed: false, skipped: "missing" };
  const before = await readFile(file, "utf8");
  const after = transform(before);
  if (after === before) return { file: relative, changed: false };
  await writeFile(file, after);
  return { file: relative, changed: true };
}

export async function applyMessageMoreMenuFix(root = repoRoot) {
  const frontend = path.join(root, "frontend/src");
  if (!existsSync(frontend)) return [];

  const results = [];
  results.push(await patchFile(root, "frontend/src/production/production.css", patchProductionCss));
  results.push(
    await patchFile(root, "frontend/src/recovered/features/conversation/workspace/view.css", patchWorkspaceViewCss),
  );
  return results;
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const results = await applyMessageMoreMenuFix(repoRoot);
  console.log(JSON.stringify(results));
}
