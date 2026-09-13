import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MESSAGE_MORE_MENU_CSS,
  MESSAGE_MORE_MENU_FIX_MARK,
  applyMessageMoreMenuFix,
  patchProductionCss,
  patchWorkspaceViewCss,
  repoRoot,
} from "../scripts/lib/message-more-menu-fix.mjs";

const FRONTEND = path.join(repoRoot, "frontend/src");
const present = existsSync(FRONTEND);

const TOOLBAR_AND_MENU_CSS = `.sand-message-hover-actions__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--cursor-text-secondary);
  background: transparent;
  border-radius: 8px;
  font-size: 14px;
}
.sand-message-hover-actions__button:hover {
  background: var(--sand-fill-ghost-hover, rgba(119, 119, 119, .173));
}
.sand-message-more-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 3;
  display: grid;
  min-width: 150px;
  padding: 4px;
  background: var(--cursor-bg-elevated);
  border: 1px solid var(--cursor-stroke-secondary);
  border-radius: 8px;
  box-shadow: var(--cursor-box-shadow-md, 0 12px 28px rgba(0, 0, 0, .35));
}
.sand-message-more-menu .sand-message-hover-actions__button {
  width: auto;
  height: auto;
  min-height: 28px;
  padding: 4px 8px;
  justify-content: flex-start;
  border: 0;
  border-radius: 5px;
}
`;

function ruleSelectors(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...stripped.matchAll(/([^{}]+)\{/g)].map((match) => match[1].trim()).filter(Boolean);
}

test("the more-menu override is an opaque elevated panel with roster-shaped rows", () => {
  assert.match(MESSAGE_MORE_MENU_CSS, new RegExp(MESSAGE_MORE_MENU_FIX_MARK));
  assert.match(MESSAGE_MORE_MENU_CSS, /background: var\(--sand-bg-elevated, Canvas\);/);
  assert.match(MESSAGE_MORE_MENU_CSS, /backdrop-filter: none;/);
  assert.match(MESSAGE_MORE_MENU_CSS, /min-width: 180px;/);
  assert.match(MESSAGE_MORE_MENU_CSS, /gap: 10px;/);
  assert.match(MESSAGE_MORE_MENU_CSS, /font-size: 13px;/);
  assert.match(MESSAGE_MORE_MENU_CSS, /line-height: 18px;/);
  assert.match(MESSAGE_MORE_MENU_CSS, /min-height: 30px;/);
  assert.match(MESSAGE_MORE_MENU_CSS, /padding: 0 8px;/);
  assert.match(MESSAGE_MORE_MENU_CSS, /border-radius: 6px;/);
  assert.match(MESSAGE_MORE_MENU_CSS, /:hover:not\(:disabled\) \{\s*background: var\(--cursor-bg-hover, var\(--cursor-bg-secondary\)\);/);
  assert.doesNotMatch(MESSAGE_MORE_MENU_CSS, /--sand-fill-ghost-hover/);
  assert.doesNotMatch(MESSAGE_MORE_MENU_CSS, /--cursor-bg-elevated/);
  assert.doesNotMatch(MESSAGE_MORE_MENU_CSS, /#20231f|#292929|rgba\(119, 119, 119/);
  assert.doesNotMatch(MESSAGE_MORE_MENU_CSS, /\bfont:/);
});

test("every hover-actions button rule is nested under the more-menu", () => {
  const buttonRules = ruleSelectors(MESSAGE_MORE_MENU_CSS).filter((selector) =>
    selector.includes("sand-message-hover-actions__button"),
  );
  assert.ok(buttonRules.length >= 2, "menu items and their hover must both be restyled");
  for (const selector of buttonRules) {
    assert.match(selector, /\.sand-message-more-menu:not\(#\\#\):not\(#\\#\)/);
    assert.notEqual(selector.trim(), ".sand-message-hover-actions__button");
  }
  const panel = ruleSelectors(MESSAGE_MORE_MENU_CSS).find(
    (selector) => selector.startsWith(".sand-message-more-menu") && !selector.includes("sand-message-hover-actions"),
  );
  assert.ok(panel);
  assert.doesNotMatch(panel, /sand-message-hover-actions__button/);
});

test("patching production CSS is idempotent and does not rewrite toolbar rules", () => {
  const once = patchProductionCss("/* base */\n.sand-message-hover-actions__button { width: 24px; }\n");
  assert.ok(once.includes(MESSAGE_MORE_MENU_FIX_MARK));
  assert.match(once, /\.sand-message-hover-actions__button \{ width: 24px; \}/);
  assert.equal(patchProductionCss(once), once, "idempotent");
  assert.equal(once.includes(MESSAGE_MORE_MENU_CSS.trim()), true);
});

test("workspace view.css keeps the recovered toolbar chips and gains the override", () => {
  const once = patchWorkspaceViewCss(TOOLBAR_AND_MENU_CSS);
  assert.ok(once.includes(MESSAGE_MORE_MENU_FIX_MARK));
  const toolbar = once.match(/\.sand-message-hover-actions__button \{[^}]*\}/)[0];
  assert.match(toolbar, /width: 24px;/);
  assert.match(toolbar, /height: 24px;/);
  assert.doesNotMatch(toolbar, /gap:/);
  assert.match(once, /\.sand-message-more-menu \{[^}]*background: var\(--cursor-bg-elevated\);/);
  assert.match(once, /\.sand-message-more-menu:not\(#\\#\):not\(#\\#\) \{[^}]*--sand-bg-elevated/);
  assert.equal(patchWorkspaceViewCss(once), once, "idempotent");
  assert.equal(
    patchWorkspaceViewCss(".sand-prompt-shell { border-radius: 999px; }\n"),
    ".sand-prompt-shell { border-radius: 999px; }\n",
    "files without a more-menu are left alone",
  );
});

test("restore and the Vite packager both apply the more-menu fix", async () => {
  const restore = await readFile(path.join(repoRoot, "scripts/ci-restore-recovered.sh"), "utf8");
  const packager = await readFile(path.join(repoRoot, "scripts/renderer-production-build.mjs"), "utf8");
  assert.match(restore, /message-more-menu-fix\.mjs/);
  assert.match(packager, /applyMessageMoreMenuFix/);
  assert.match(packager, /await applyMessageMoreMenuFix\(repoRoot\)/);
});

test("applyMessageMoreMenuFix is a no-op without frontend/ and patches a stub tree", async () => {
  assert.deepEqual(await applyMessageMoreMenuFix(path.join(os.tmpdir(), "no-frontend-here")), []);
  const root = await mkdtemp(path.join(os.tmpdir(), "more-menu-"));
  try {
    await mkdir(path.join(root, "frontend/src/production"), { recursive: true });
    await mkdir(path.join(root, "frontend/src/recovered/features/conversation/workspace"), { recursive: true });
    await writeFile(path.join(root, "frontend/src/production/production.css"), ".sand-settings-dialog{}\n");
    await writeFile(
      path.join(root, "frontend/src/recovered/features/conversation/workspace/view.css"),
      TOOLBAR_AND_MENU_CSS,
    );
    const results = await applyMessageMoreMenuFix(root);
    assert.ok(results.some((row) => row.changed));
    const production = await readFile(path.join(root, "frontend/src/production/production.css"), "utf8");
    const view = await readFile(
      path.join(root, "frontend/src/recovered/features/conversation/workspace/view.css"),
      "utf8",
    );
    assert.match(production, new RegExp(MESSAGE_MORE_MENU_FIX_MARK));
    assert.match(view, new RegExp(MESSAGE_MORE_MENU_FIX_MARK));
    const toolbar = view.match(/\.sand-message-hover-actions__button \{[^}]*\}/)[0];
    assert.match(toolbar, /width: 24px;/);
    assert.doesNotMatch(toolbar, /gap:/);
    const again = await applyMessageMoreMenuFix(root);
    assert.equal(
      again.every((row) => row.changed === false),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "restored frontend more-menu is opaque and the toolbar chips stay 24×24",
  { skip: present ? false : "frontend/ is restored from stow; skip when absent" },
  async () => {
    await applyMessageMoreMenuFix(repoRoot);
    const production = await readFile(path.join(FRONTEND, "production/production.css"), "utf8");
    const view = await readFile(path.join(FRONTEND, "recovered/features/conversation/workspace/view.css"), "utf8");
    assert.match(production, new RegExp(MESSAGE_MORE_MENU_FIX_MARK));
    assert.match(view, new RegExp(MESSAGE_MORE_MENU_FIX_MARK));
    assert.match(production, /background: var\(--sand-bg-elevated, Canvas\);/);
    assert.match(view, /\.sand-message-hover-actions__button \{[^}]*width: 24px/);
    assert.match(view, /\.sand-message-hover-actions__button \{[^}]*height: 24px/);
    const toolbar = view.match(/\.sand-message-hover-actions__button \{[^}]*\}/)[0];
    assert.doesNotMatch(toolbar, /gap:/);
    assert.match(view, /\.sand-message-hover-actions__button:hover \{[^}]*--sand-fill-ghost-hover/);
  },
);
