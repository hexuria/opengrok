import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as acorn from "acorn";
import { COMPONENT_SOURCE } from "../scripts/lib/router-renderer-patch.mjs";
import {
  OVERLAY_STACK_HELPER,
  SETTINGS_OVERLAY_STACK_CSS,
  SETTINGS_UI_FIX_MARK,
  applySettingsUiFixes,
  overlayDialogBodyIndex,
  patchFloatingSurfacesToWall,
  patchInFlowLanguageList,
  patchNestedDialogClose,
  patchOverlayPrimitives,
  patchProductionCss,
  repoRoot,
} from "../scripts/lib/settings-ui-fixes.mjs";

const FRONTEND = path.join(repoRoot, "frontend/src");
const present = existsSync(FRONTEND);

const stripTypes = (source) =>
  source
    .replaceAll(": unknown[]", "")
    .replaceAll(": unknown", "")
    .replaceAll(": KeyboardEvent", "");

const parses = (source) => acorn.parse(stripTypes(source), { ecmaVersion: "latest", sourceType: "module" });

test("the overlay stack only lets the top dialog dismiss", () => {
  const api = new Function(
    `${stripTypes(OVERLAY_STACK_HELPER)}; return { __sandOverlayRegister, __sandOverlayIsTop, __sandOverlayCanDismiss };`,
  )();
  const parent = {};
  const child = {};
  const unregParent = api.__sandOverlayRegister(parent);
  assert.equal(api.__sandOverlayIsTop(parent), true);
  const unregChild = api.__sandOverlayRegister(child);
  assert.equal(api.__sandOverlayIsTop(parent), false);
  assert.equal(api.__sandOverlayIsTop(child), true);
  unregChild();
  assert.equal(api.__sandOverlayIsTop(parent), true);
  assert.equal(api.__sandOverlayCanDismiss(parent), false, "the click that closed the child must not dismiss the parent");
  unregParent();
});

test("production CSS raises menus above the settings scrim and punches the info pane", () => {
  const once = patchProductionCss("/* base */\n.sand-settings-dialog { color: red; }\n");
  assert.ok(once.includes(SETTINGS_UI_FIX_MARK));
  assert.ok(once.includes("--sand-layer-wall"));
  assert.ok(once.includes("--sand-layer-scrim"));
  assert.ok(once.includes(".sand-info-pane"));
  assert.ok(once.includes(".sand-cover-drag"));
  assert.equal(patchProductionCss(once), once, "idempotent");
  assert.equal(once.includes(SETTINGS_OVERLAY_STACK_CSS.trim()), true);
});

test("floating primitives move from popover to wall; hover cards are not in that file", () => {
  const source = `[data-sand-floating-surface="true"] { z-index: var(--sand-layer-popover); }\n`;
  const once = patchFloatingSurfacesToWall(source);
  assert.match(once, /sand-layer-wall/);
  assert.doesNotMatch(once, /sand-layer-popover/);
  assert.equal(patchFloatingSurfacesToWall(once), once);
});

test("OverlayDialog body index survives multiline props and callback types", () => {
  const source = `
export function OverlayDialog({
  open,
  onClose,
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose(): void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  return null;
}
`;
  const index = overlayDialogBodyIndex(source);
  assert.ok(index > 0);
  assert.equal(source.slice(index).trimStart().startsWith("return null"), true);
});

test("OverlayDialog gains a stack register and gates Escape and backdrop", () => {
  const source = `import { useEffect } from "react";
export function OverlayDialog({ open, onClose, closeOnBackdrop = true }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const onBackdrop = (event) => {
    if (event.target === event.currentTarget && closeOnBackdrop) onClose();
  };
  return onBackdrop;
}
`;
  const once = patchOverlayPrimitives(source);
  parses(once);
  assert.match(once, /__sandOverlayRegister/);
  assert.match(once, /__sandOverlayIsTop/);
  assert.match(once, /__sandOverlayCanDismiss/);
  assert.match(once, /useRef/);
  assert.match(once, /__sandOverlayDialogs: unknown\[\]/);
  assert.match(once, /id: unknown/);
  assert.match(once, /event: KeyboardEvent/);
  assert.match(once, /typeof onClose === "function"\) onClose\(\)/);
  assert.doesNotMatch(once, /typeof props/);
  assert.match(once, /event\.key === "Escape" && __sandOverlayIsTop\(__sandOverlayId\)/);
  assert.match(once, /event\.target === event\.currentTarget && __sandOverlayCanDismiss\(__sandOverlayId\)/);
  assert.equal(patchOverlayPrimitives(once), once, "idempotent");

  const propsStyle = `import { useEffect } from "react";
export function OverlayDialog(props) {
  useEffect(() => {
    if (props.open && event.key === "Escape") props.onClose();
  }, [props]);
  return null;
}
`;
  const patchedProps = patchOverlayPrimitives(propsStyle);
  parses(patchedProps);
  assert.match(patchedProps, /props\.open/);
  assert.match(patchedProps, /typeof props\.onClose === "function"\) props\.onClose\(\)/);
  assert.doesNotMatch(patchedProps, /typeof onClose === "function"\) onClose\(\)/);
});

test("in-flow dictation language lists become absolutely positioned", () => {
  const jsx = `langOpen ? <div style={{marginTop:6,maxHeight:180,overflowY:"auto",border:"1px solid x"}}>opts</div> : null`;
  const floated = patchInFlowLanguageList(jsx);
  assert.match(floated, /position:"absolute"/);
  assert.match(floated, /zIndex:"var\(--sand-layer-wall\)"/);
  assert.match(floated, /top:"100%"/);
  assert.equal(patchInFlowLanguageList(floated), floated);
  const createElement = `langOpen&&a.jsxs("div",{style:{marginTop:6,maxHeight:180,overflowY:"auto"}} )`;
  assert.match(patchInFlowLanguageList(createElement), /position:"absolute"/);
  const px = `langOpen ? <div style={{ maxHeight: "180px", overflowY: "auto" }}>opts</div> : null`;
  assert.match(patchInFlowLanguageList(px), /position:"absolute"/);
});

test("Standing rules close is deferred so the parent dialog stays mounted", () => {
  const source = `
    <OverlayDialog label="Standing rules" open={managing} onClose={() => setManaging(false)}>
      <button onClick={() => setManaging(false)}>Close</button>
    </OverlayDialog>
  `;
  const once = patchNestedDialogClose(source);
  assert.match(once, /queueMicrotask\(\(\) => setManaging\(false\)\)/);
  assert.equal(patchNestedDialogClose(once), once);
  assert.equal(patchNestedDialogClose(`<div>Theme</div>`), `<div>Theme</div>`);
});

test("the fidelity dictation list floats and Standing rules defers dismiss", () => {
  assert.match(COMPONENT_SOURCE, /position:"absolute",zIndex:"var\(--sand-layer-wall\)"/);
  assert.match(COMPONENT_SOURCE, /overflow:"visible"/);
  assert.match(COMPONENT_SOURCE, /queueMicrotask\(onClose\)/);
  acorn.parse(COMPONENT_SOURCE, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
});

test("restore and the Vite packager both apply the settings UI fixes", async () => {
  const restore = await readFile(path.join(repoRoot, "scripts/ci-restore-recovered.sh"), "utf8");
  const packager = await readFile(path.join(repoRoot, "scripts/renderer-production-build.mjs"), "utf8");
  assert.match(restore, /settings-ui-fixes\.mjs/);
  assert.match(packager, /applySettingsUiFixes/);
  assert.match(packager, /await applySettingsUiFixes\(repoRoot\)/);
});

test("applySettingsUiFixes is a no-op without frontend/ and patches a stub tree", async () => {
  assert.deepEqual(await applySettingsUiFixes(path.join(os.tmpdir(), "no-frontend-here")), []);
  const root = await mkdtemp(path.join(os.tmpdir(), "settings-ui-"));
  try {
    await mkdir(path.join(root, "frontend/src/production/patched-ui"), { recursive: true });
    await mkdir(path.join(root, "frontend/src/recovered/ui"), { recursive: true });
    await writeFile(path.join(root, "frontend/src/production/production.css"), ".sand-settings-dialog{}\n");
    await writeFile(
      path.join(root, "frontend/src/recovered/ui/sand-floating-primitives.css"),
      `[data-sand-floating-surface="true"] { z-index: var(--sand-layer-popover); }\n`,
    );
    await writeFile(
      path.join(root, "frontend/src/recovered/ui/overlay-primitives.tsx"),
      `import { useEffect } from "react";
export function OverlayDialog({ open, onClose, closeOnBackdrop = true }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return null;
}
`,
    );
    await writeFile(
      path.join(root, "frontend/src/production/patched-ui/DictationPanel.tsx"),
      `export function DictationPanel() { return langOpen ? <div style={{marginTop:6,maxHeight:180,overflowY:"auto"}} /> : null }`,
    );
    await writeFile(
      path.join(root, "frontend/src/production/patched-ui/LocalComputerPanel.tsx"),
      `export function Local() { return <OverlayDialog label="Standing rules" onClose={() => setManaging(false)} /> }`,
    );
    const results = await applySettingsUiFixes(root);
    assert.ok(results.some((row) => row.changed));
    const css = await readFile(path.join(root, "frontend/src/production/production.css"), "utf8");
    const floating = await readFile(path.join(root, "frontend/src/recovered/ui/sand-floating-primitives.css"), "utf8");
    const overlay = await readFile(path.join(root, "frontend/src/recovered/ui/overlay-primitives.tsx"), "utf8");
    const dictation = await readFile(path.join(root, "frontend/src/production/patched-ui/DictationPanel.tsx"), "utf8");
    const computer = await readFile(path.join(root, "frontend/src/production/patched-ui/LocalComputerPanel.tsx"), "utf8");
    assert.match(css, new RegExp(SETTINGS_UI_FIX_MARK));
    assert.match(floating, /sand-layer-wall/);
    assert.match(overlay, /__sandOverlayRegister/);
    assert.match(dictation, /position:"absolute"/);
    assert.match(computer, /queueMicrotask/);
    const again = await applySettingsUiFixes(root);
    assert.equal(again.every((row) => row.changed === false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restored frontend carries the settings UI layering fixes", { skip: present ? false : "frontend/ is restored from stow; skip when absent" }, async () => {
  await applySettingsUiFixes(repoRoot);
  const css = await readFile(path.join(FRONTEND, "production/production.css"), "utf8");
  assert.match(css, new RegExp(SETTINGS_UI_FIX_MARK));
  assert.match(css, /--sand-layer-wall/);
  const floatingCss = path.join(FRONTEND, "recovered/ui/sand-floating-primitives.css");
  if (existsSync(floatingCss)) {
    const text = await readFile(floatingCss, "utf8");
    assert.match(text, /sand-layer-wall/);
  }
  const overlayTsx = path.join(FRONTEND, "recovered/ui/overlay-primitives.tsx");
  const overlayTs = path.join(FRONTEND, "recovered/ui/overlay-primitives.ts");
  const overlayPath = existsSync(overlayTsx) ? overlayTsx : overlayTs;
  assert.ok(existsSync(overlayPath), "OverlayDialog lives in overlay-primitives");
  const overlay = await readFile(overlayPath, "utf8");
  assert.match(overlay, /__sandOverlayRegister/);
  const dictation = path.join(FRONTEND, "production/patched-ui/DictationPanel.tsx");
  if (existsSync(dictation)) {
    const text = await readFile(dictation, "utf8");
    assert.match(text, /position:\s*["']absolute["']/);
  }
  const computer = path.join(FRONTEND, "production/patched-ui/LocalComputerPanel.tsx");
  if (existsSync(computer)) {
    const text = await readFile(computer, "utf8");
    if (/Standing rules/.test(text)) {
      assert.match(text, /queueMicrotask/);
    }
  }
  const hover = await readFile(path.join(FRONTEND, "recovered/features/conversation/workspace/view.css"), "utf8");
  assert.match(hover, /z-index: var\(--sand-layer-popover\);/);
});
