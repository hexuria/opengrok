/**
 * Settings overlay stacking, nested-dialog dismiss, and in-flow comboboxes.
 *
 * frontend/ is restored from stow and is not tracked here. These transforms
 * run after restore (and again before the Vite packager) so the public repo
 * can own the fix without committing recovered files.
 *
 * What they correct:
 * 1. Select/menu popovers sit on --sand-layer-popover, which is below the
 *    dialog scrim, so Theme / Accent / Timezone / notification-sound lists
 *    paint *behind* Settings. The right info pane is chrome and can sit over
 *    the dialog's right-hand controls, which is the same click-blocking class
 *    as the sidebar overlay: an element outside the dialog still hit-tests.
 * 2. Nested OverlayDialog / Os (Standing rules Manage…) share Escape and a
 *    click-through after the child unmounts, so closing the child also closes
 *    Settings.
 * 3. The Dictation language list is in normal flow, so opening it grows the
 *    card instead of floating.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");

export const SETTINGS_UI_FIX_MARK = "sand-settings-ui-fix";

/** Appended to production.css so dialogs beat the info pane and menus beat dialogs. */
export const SETTINGS_OVERLAY_STACK_CSS = `/* ${SETTINGS_UI_FIX_MARK}: dialogs above the info pane; menus above the dialog */
html:has([data-ui-dialog-root]) .sand-cover-drag:not(#\\#):not(#\\#),
html:has(.sand-settings-dialog) .sand-cover-drag:not(#\\#):not(#\\#) {
  -webkit-app-region: no-drag !important;
  app-region: no-drag !important;
}
html:has([data-ui-dialog-root]) .sand-info-pane:not(#\\#):not(#\\#):not(#\\#),
html:has([data-ui-dialog-root]) .sand-info-pane *:not(#\\#):not(#\\#):not(#\\#),
html:has(.sand-settings-dialog) .sand-info-pane:not(#\\#):not(#\\#):not(#\\#),
html:has(.sand-settings-dialog) .sand-info-pane *:not(#\\#):not(#\\#):not(#\\#) {
  pointer-events: none !important;
}
[data-ui-dialog-root]:not(#\\#):not(#\\#),
.sand-settings-overlay:not(#\\#):not(#\\#),
.sand-settings-dialog:not(#\\#):not(#\\#) {
  z-index: var(--sand-layer-scrim);
  pointer-events: auto;
}
html:has([data-ui-dialog-root]) [data-sand-floating-surface="true"]:not(#\\#):not(#\\#),
html:has([data-ui-dialog-root]) [data-component="menu-popup"]:not(#\\#):not(#\\#),
html:has([data-ui-dialog-root]) [data-component="select-popup"]:not(#\\#):not(#\\#),
html:has([data-ui-dialog-root]) [data-component="combobox-popup"]:not(#\\#):not(#\\#),
html:has([data-ui-dialog-root]) [role="listbox"]:not(#\\#):not(#\\#),
html:has([data-ui-dialog-root]) .ui-select-popup:not(#\\#):not(#\\#),
html:has([data-ui-dialog-root]) .ui-menu-popup:not(#\\#):not(#\\#),
html:has(.sand-settings-dialog) [data-sand-floating-surface="true"]:not(#\\#):not(#\\#),
html:has(.sand-settings-dialog) [data-component="menu-popup"]:not(#\\#):not(#\\#),
html:has(.sand-settings-dialog) [data-component="select-popup"]:not(#\\#):not(#\\#),
html:has(.sand-settings-dialog) [data-component="combobox-popup"]:not(#\\#):not(#\\#),
html:has(.sand-settings-dialog) [role="listbox"]:not(#\\#):not(#\\#),
html:has(.sand-settings-dialog) .ui-select-popup:not(#\\#):not(#\\#),
html:has(.sand-settings-dialog) .ui-menu-popup:not(#\\#):not(#\\#) {
  z-index: var(--sand-layer-wall) !important;
  pointer-events: auto !important;
}
`;

export const OVERLAY_STACK_HELPER = `const __sandOverlayDialogs: unknown[] = [];
let __sandOverlayQuietUntil = 0;
function __sandOverlayRegister(id: unknown) {
  __sandOverlayDialogs.push(id);
  return () => {
    const index = __sandOverlayDialogs.lastIndexOf(id);
    if (index >= 0) __sandOverlayDialogs.splice(index, 1);
    __sandOverlayQuietUntil = Date.now() + 80;
  };
}
function __sandOverlayIsTop(id: unknown) {
  return __sandOverlayDialogs[__sandOverlayDialogs.length - 1] === id;
}
function __sandOverlayCanDismiss(id: unknown) {
  if (Date.now() < __sandOverlayQuietUntil) return false;
  return __sandOverlayIsTop(id);
}

`;

function lastImportIndex(source) {
  let last = -1;
  for (const match of source.matchAll(/^import .+;?\n/gm)) {
    last = match.index + match[0].length;
  }
  return last;
}

function skipWhitespace(source, index) {
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

function skipGenericParams(source, index) {
  index = skipWhitespace(source, index);
  if (source[index] !== "<") return index;
  let depth = 0;
  for (; index < source.length; index += 1) {
    if (source[index] === "<") depth += 1;
    else if (source[index] === ">") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return index;
}

/**
 * Index of the first character inside OverlayDialog's function body, or -1.
 * Walks the parameter list by paren depth so multiline props and TS types
 * with `()` (callbacks, RefObject) do not fool a `[^)]*` regex.
 */
export function overlayDialogBodyIndex(source) {
  const names = ["export function OverlayDialog", "export const OverlayDialog", "function OverlayDialog"];
  let at = -1;
  for (const name of names) {
    const index = source.indexOf(name);
    if (index >= 0) {
      at = index + name.length;
      break;
    }
  }
  if (at < 0) return -1;
  at = skipGenericParams(source, at);
  at = skipWhitespace(source, at);
  if (source.startsWith("=", at)) {
    at = skipWhitespace(source, at + 1);
  }
  const paren = source.indexOf("(", at);
  if (paren < 0) return -1;
  let depth = 0;
  let index = paren;
  for (; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        index += 1;
        break;
      }
    }
  }
  index = skipWhitespace(source, index);
  if (source[index] === ":") {
    while (index < source.length && source[index] !== "{" && !(source[index] === "=" && source[index + 1] === ">")) {
      index += 1;
    }
  }
  index = skipWhitespace(source, index);
  if (source.startsWith("=>", index)) {
    index = skipWhitespace(source, index + 2);
  }
  if (source[index] !== "{") return -1;
  return index + 1;
}

function overlayParamText(source, bodyIndex) {
  const nameAt = source.lastIndexOf("OverlayDialog", bodyIndex);
  const paren = source.indexOf("(", nameAt);
  if (paren < 0 || paren > bodyIndex) return "";
  return source.slice(paren, bodyIndex);
}

function overlayOpenExpression(paramText) {
  if (/\bprops\b/.test(paramText) && !/\bopen\b/.test(paramText)) return "props.open";
  if (/\bopen\b/.test(paramText)) return "open";
  if (/\bprops\b/.test(paramText)) return "props.open";
  return "open";
}

function overlayCloseExpression(paramText) {
  if (/\bprops\b/.test(paramText) && !/\bonClose\b/.test(paramText)) return "props.onClose";
  if (/\bonClose\b/.test(paramText)) return "onClose";
  if (/\bprops\b/.test(paramText)) return "props.onClose";
  return "onClose";
}

function overlayHookName(source, name) {
  const namedImport = new RegExp(String.raw`import\s+(?:[\w*]+\s*,\s*)?\{[^}]*\b${name}\b[^}]*\}\s*from\s*["']react["']`);
  if (namedImport.test(source)) return name;
  return `React.${name}`;
}

export function ensureReactHookImports(source, names) {
  const missing = names.filter((name) => {
    const namedImport = new RegExp(String.raw`import\s+(?:[\w*]+\s*,\s*)?\{[^}]*\b${name}\b[^}]*\}\s*from\s*["']react["']`);
    return !namedImport.test(source);
  });
  if (missing.length === 0) return source;
  if (/import\s+\*\s+as\s+React\s+from\s*["']react["']/.test(source)) return source;
  const named = source.match(/import\s+(?:[\w*]+\s*,\s*)?\{([^}]+)\}\s*from\s*["']react["']/);
  if (named) {
    const inner = named[1];
    const have = new Set(inner.split(",").map((part) => part.trim().split(/\s+as\s+/).pop().trim()));
    const add = missing.filter((name) => !have.has(name));
    if (add.length === 0) return source;
    const nextInner = `${inner.trim().replace(/,\s*$/, "")}, ${add.join(", ")}`;
    return `${source.slice(0, named.index)}${named[0].replace(inner, nextInner)}${source.slice(named.index + named[0].length)}`;
  }
  const defaultOnly = source.match(/import\s+React\s+from\s*["']react["']/);
  if (defaultOnly) {
    return source.replace(defaultOnly[0], `import React, { ${missing.join(", ")} } from "react"`);
  }
  const last = lastImportIndex(source);
  const line = `import { ${missing.join(", ")} } from "react";\n`;
  if (last > 0) return `${source.slice(0, last)}${line}${source.slice(last)}`;
  return `${line}${source}`;
}

function insertAfterImports(source, chunk) {
  if (source.startsWith('"use client"') || source.startsWith("'use client'")) {
    const newline = source.indexOf("\n");
    const head = source.slice(0, newline + 1);
    const rest = source.slice(newline + 1);
    const at = lastImportIndex(rest);
    if (at > 0) return `${head}${rest.slice(0, at)}${chunk}${rest.slice(at)}`;
    return `${head}${chunk}${rest}`;
  }
  const at = lastImportIndex(source);
  if (at > 0) return `${source.slice(0, at)}\n${chunk}${source.slice(at)}`;
  return `${chunk}${source}`;
}

export function patchProductionCss(source) {
  if (source.includes(SETTINGS_UI_FIX_MARK)) return source;
  const trimmed = source.endsWith("\n") ? source : `${source}\n`;
  return `${trimmed}\n${SETTINGS_OVERLAY_STACK_CSS}`;
}

export function patchFloatingSurfacesToWall(source) {
  if (!source.includes("--sand-layer-popover")) return source;
  if (source.includes(`${SETTINGS_UI_FIX_MARK}: floating surfaces use wall`)) return source;
  // Selects, menus and comboboxes in this file are the surfaces that open from
  // Settings. Hover cards live in workspace view.css and stay on popover.
  const next = source.replaceAll("var(--sand-layer-popover)", "var(--sand-layer-wall)");
  if (next === source) return source;
  return `/* ${SETTINGS_UI_FIX_MARK}: floating surfaces use wall */\n${next}`;
}

export function patchOverlayPrimitives(source) {
  if (source.includes("__sandOverlayRegister")) return source;
  if (!/\bOverlayDialog\b/.test(source)) {
    throw new Error("overlay-primitives does not export OverlayDialog");
  }

  const withHooks = ensureReactHookImports(source, ["useRef", "useEffect"]);
  const withHelper = insertAfterImports(withHooks, OVERLAY_STACK_HELPER);
  const bodyIndex = overlayDialogBodyIndex(withHelper);
  if (bodyIndex < 0) {
    throw new Error("overlay-primitives: OverlayDialog function body was not locatable");
  }

  const useRef = overlayHookName(withHelper, "useRef");
  const useEffect = overlayHookName(withHelper, "useEffect");
  const paramText = overlayParamText(withHelper, bodyIndex);
  const openExpr = overlayOpenExpression(paramText);
  const closeExpr = overlayCloseExpression(paramText);
  const register = `
  const __sandOverlayId = ${useRef}(null);
  const __sandOverlayOpen = ${openExpr};
  ${useEffect}(() => {
    if (!__sandOverlayOpen) return undefined;
    const unregister = __sandOverlayRegister(__sandOverlayId);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!__sandOverlayIsTop(__sandOverlayId)) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      if (typeof ${closeExpr} === "function") ${closeExpr}();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      unregister();
    };
  }, [__sandOverlayOpen]);
`;

  let injected = `${withHelper.slice(0, bodyIndex)}${register}${withHelper.slice(bodyIndex)}`;
  injected = injected.replace(
    /((?:event|ev|e)\.target\s*===\s*(?:event|ev|e)\.currentTarget)/g,
    "$1 && __sandOverlayCanDismiss(__sandOverlayId)",
  );
  injected = injected.replace(
    /closeOnBackdrop\s*&&\s*onClose\(\)/g,
    "closeOnBackdrop && __sandOverlayCanDismiss(__sandOverlayId) && onClose()",
  );
  injected = injected.replace(
    /if\s*\(\s*closeOnBackdrop\s*\)\s*onClose\(\)/g,
    "if (closeOnBackdrop && __sandOverlayCanDismiss(__sandOverlayId)) onClose()",
  );
  injected = injected.replace(
    /if\s*\(\s*((?:event|ev|e)\.key\s*===\s*["']Escape["'])\s*\)/g,
    "if ($1 && __sandOverlayIsTop(__sandOverlayId))",
  );
  injected = injected.replace(
    /((?:event|ev|e)\.key\s*===\s*["']Escape["'])\s*&&/g,
    "$1 && __sandOverlayIsTop(__sandOverlayId) &&",
  );
  injected = injected.replace(
    /if\s*\(\s*((?:event|ev|e)\.key\s*!==\s*["']Escape["'])\s*\)\s*return/g,
    "if ($1 || !__sandOverlayIsTop(__sandOverlayId)) return",
  );
  return injected;
}

/**
 * Pull an in-flow language list out of layout. The parent is already
 * position:relative; without position:absolute the card grows with the list.
 */
export function patchInFlowLanguageList(source) {
  if (/position:\s*(?:["']absolute["']|absolute)[\s\S]{0,160}maxHeight:\s*(?:180|"180px"|'180px')/.test(source)) return source;
  const height = String.raw`maxHeight:\s*(?:180|"180px"|'180px')`;
  const jsx = source.match(new RegExp(String.raw`style=\{\{\s*((?:[^{}]|\n)*${height}(?:[^{}]|\n)*)\}\}`));
  if (jsx && !/position:\s*["']absolute["']/.test(jsx[1])) {
    const floated = `style={{position:"absolute",zIndex:"var(--sand-layer-wall)",left:0,right:0,top:"100%",${jsx[1].trim()}}}`;
    return `${source.slice(0, jsx.index)}${floated}${source.slice(jsx.index + jsx[0].length)}`;
  }
  const createElement = source.match(new RegExp(String.raw`style:\{((?:[^{}]|\n)*${height}(?:[^{}]|\n)*)\}`));
  if (createElement && !/position:\s*["']absolute["']/.test(createElement[1])) {
    const floated = `style:{position:"absolute",zIndex:"var(--sand-layer-wall)",left:0,right:0,top:"100%",${createElement[1].trim()}}`;
    return `${source.slice(0, createElement.index)}${floated}${source.slice(createElement.index + createElement[0].length)}`;
  }
  return source;
}

export function patchNestedDialogClose(source) {
  if (!/Standing rules/.test(source) && !/standingRules/.test(source) && !/standing-rules/.test(source)) {
    return source;
  }
  if (source.includes("queueMicrotask(() => setManaging(false))") || source.includes("queueMicrotask(onClose)")) {
    return source;
  }

  let next = source;
  if (/setManaging\(\s*false\s*\)/.test(next)) {
    next = next.replace(/setManaging\(\s*false\s*\)/g, "queueMicrotask(() => setManaging(false))");
  }
  next = next.replace(
    /onClose=\{\(\) => setState\(([^)]*managing:\s*false[^)]*)\)\}/g,
    "onClose={() => queueMicrotask(() => setState($1))}",
  );
  return next;
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

export async function applySettingsUiFixes(root = repoRoot) {
  const frontend = path.join(root, "frontend/src");
  if (!existsSync(frontend)) return [];

  const results = [];
  results.push(await patchFile(root, "frontend/src/production/production.css", patchProductionCss));
  results.push(await patchFile(root, "frontend/src/recovered/ui/sand-floating-primitives.css", patchFloatingSurfacesToWall));
  results.push(await patchFile(root, "frontend/src/recovered/ui/sand-floating-primitives.tsx", patchFloatingSurfacesToWall));

  const overlayPath = existsSync(path.join(root, "frontend/src/recovered/ui/overlay-primitives.tsx"))
    ? "frontend/src/recovered/ui/overlay-primitives.tsx"
    : existsSync(path.join(root, "frontend/src/recovered/ui/overlay-primitives.ts"))
      ? "frontend/src/recovered/ui/overlay-primitives.ts"
      : null;
  if (overlayPath) {
    results.push(await patchFile(root, overlayPath, patchOverlayPrimitives));
  }

  for (const relative of [
    "frontend/src/production/patched-ui/DictationPanel.tsx",
    "frontend/src/recovered/features/settings/overlay/dictation.tsx",
  ]) {
    results.push(await patchFile(root, relative, patchInFlowLanguageList));
  }

  for (const relative of [
    "frontend/src/production/patched-ui/LocalComputerPanel.tsx",
    "frontend/src/recovered/features/settings/overlay/computer-runtime.tsx",
  ]) {
    results.push(await patchFile(root, relative, patchNestedDialogClose));
  }

  return results;
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const results = await applySettingsUiFixes(repoRoot);
  console.log(JSON.stringify(results));
}
