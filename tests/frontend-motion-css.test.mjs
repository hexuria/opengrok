import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");

test("the ported spring curve keeps every stop from 0.27", async () => {
  const motion = await read("frontend/src/recovered/ui/sand-motion.css");
  const curve = /--sand-easing-spring:\s*linear\(([^;]*)\);/s.exec(motion);
  assert.ok(curve, "--sand-easing-spring must be declared as a linear() curve");
  const stops = curve[1].split(",").map((stop) => stop.trim()).filter(Boolean);
  // Verified against gb027 index-BhL2J-Bw.css: 32 stops exactly. A minifier
  // that drops any of them changes the feel.
  assert.equal(stops.length, 32);
  assert.equal(stops[0], "0");
  assert.equal(stops.at(-1), "1 100%");
  for (const sample of [".01588 2%", ".51029 18%", ".89376 40%", ".99829 90%"]) {
    assert.ok(curve[1].includes(sample), `spring curve is missing the stop ${sample}`);
  }
});

test("motion easings and reduced-motion fallbacks are declared once, centrally", async () => {
  const motion = await read("frontend/src/recovered/ui/sand-motion.css");
  for (const token of [
    "--sand-easing-enter: cubic-bezier(.22, 1, .36, 1)",
    "--sand-easing-overshoot: cubic-bezier(.34, 1.56, .64, 1)",
    "--sand-easing-row: cubic-bezier(.1, .9, .2, 1)",
    "--sand-easing-sweep: cubic-bezier(.45, 0, .2, 1)",
    "--cursor-easing-out-cubic: cubic-bezier(.215, .61, .355, 1)",
    "--sand-duration-reduced: .12s",
  ]) {
    assert.ok(motion.includes(token), `sand-motion.css is missing ${token}`);
  }

  for (const frames of [
    "sand-spring-pop-in",
    "sand-badge-pop",
    "sand-slide-in-spring",
    "sand-count-roll-out",
    "sand-count-roll-in",
    "sand-typing-dot",
    "sand-indeterminate-sweep",
  ]) {
    assert.match(motion, new RegExp(`@keyframes ${frames}\\b`));
  }

  // Every animated utility must answer prefers-reduced-motion.
  const reduced = motion.slice(motion.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const utility of ["sand-motion-pop-in", "sand-motion-slide-in", "sand-motion-row-enter"]) {
    assert.ok(reduced.includes(utility), `${utility} has no reduced-motion answer`);
  }

  const kit = await read("frontend/src/recovered/ui/sand-kit-primitives.tsx");
  assert.match(kit, /import "\.\/sand-motion\.css";/);
});

test("the chat header divider is driven by the transcript scroll timeline", async () => {
  const view = await read("frontend/src/recovered/features/conversation/workspace/view.css");
  assert.match(view, /\.sand-chat-stage \{[^}]*timeline-scope: --sand-transcript-scroll;/);
  assert.match(view, /\.sand-virtual-transcript \{[^}]*scroll-timeline-name: --sand-transcript-scroll;/);
  assert.match(view, /animation-timeline: --sand-transcript-scroll;[^}]*animation-range: 0 16px;/);

  // The header must not also paint a permanent rule, or the fade is invisible.
  const header = /\.sand-chat-header \{[^}]*\}/.exec(view);
  assert.ok(header);
  assert.ok(!header[0].includes("border-bottom"), "the divider element owns the line now");

  // Without scroll-timeline support the line has to stay drawn.
  assert.match(view, /@supports \(animation-timeline: scroll\(\)\)/);
  const divider = /\.sand-chat-header__scroll-divider \{[^}]*\}/.exec(view);
  assert.ok(divider && !divider[0].includes("opacity: 0"), "the unguarded rule must stay visible");

  const markup = await read("frontend/src/recovered/features/conversation/workspace/chat-header.tsx");
  assert.match(markup, /className="sand-chat-header__scroll-divider"/);
  assert.match(markup, /aria-hidden="true" className="sand-chat-header__scroll-divider"/);
});

test("the leftover motion vocabulary is wired to real surfaces", async () => {
  const motion = await read("frontend/src/recovered/ui/sand-motion.css");
  assert.match(motion, /\.sand-typing-dot \{/);
  assert.match(motion, /animation-duration: 1\.4s;/);
  assert.match(motion, /sand-typing-dot:nth-child\(1\) \{ animation-delay: -\.32s; \}/);
  const reduced = motion.slice(motion.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /sand-typing-dot-calm/);
  assert.match(reduced, /animation-duration: 1\.6s;/);

  const workspace = await read("frontend/src/recovered/features/conversation/workspace/view.css");
  assert.match(workspace, /\.sand-thread-affordance__count-slide/);
  assert.match(workspace, /animation-name: sand-count-roll-out;/);
  assert.match(workspace, /animation-name: sand-count-roll-in;/);
  assert.match(workspace, /animation-duration: \.3s;/);

  const thread = await read("frontend/src/recovered/features/conversation/cards/transcript-card/thread-affordance.tsx");
  assert.match(thread, /sand-thread-affordance__count-slide/);
  assert.match(thread, /onAnimationEnd/);

  const transcript = await read("frontend/src/recovered/features/conversation/workspace/transcript.tsx");
  assert.match(transcript, /sand-typing-dot/);
  assert.match(transcript, /SandIndeterminateBar/);

  const bar = await read("frontend/src/recovered/ui/sand-progress-bar.css");
  assert.match(bar, /width: 34%;/);
  assert.match(bar, /sand-indeterminate-sweep 1\.35s var\(--sand-easing-sweep\) infinite/);

  const routines = await read("frontend/src/recovered/features/automations/routines/view.css");
  assert.match(routines, /timeline-scope: --sand-routine-detail-scroll;/);
  assert.match(routines, /scroll-timeline-name: --sand-routine-detail-scroll;/);
  assert.match(routines, /animation-timeline: --sand-routine-detail-scroll;/);
  assert.match(routines, /animation-range: 0 16px;/);

  const pane = await read("frontend/src/recovered/features/automations/routines/view.tsx");
  assert.match(pane, /sand-automation-detail__scroll-divider/);
  assert.match(pane, /SandIndeterminateBar/);
});

test("the settings deep-link flash restarts by forcing a reflow", async () => {
  const css = await read("frontend/src/recovered/features/settings/overlay/view.css");
  assert.match(css, /@keyframes sand-settings-row-flash/);
  assert.match(css, /animation: sand-settings-row-flash 1\.6s ease-out 1/);
  assert.match(css, /color-mix\(in srgb, var\(--sand-fill-accent[^)]*\) 12%, transparent\)/);

  const temporary = await mkdtemp(path.join(os.tmpdir(), "settings-row-focus-"));
  try {
    const outfile = path.join(temporary, "focus.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/settings-row-focus.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "neutral",
    });
    const { sandSettingRowId, flashSettingRow, flashSettingRowByKey } = await import(pathToFileURL(outfile).href);

    assert.equal(sandSettingRowId("notification-sound"), "sand-setting-notification-sound");

    const calls = [];
    const element = {
      scrollIntoView: (options) => calls.push(`scroll:${options?.block}`),
      get offsetWidth() {
        calls.push("reflow");
        return 0;
      },
      classList: {
        add: (token) => calls.push(`add:${token}`),
        remove: (token) => calls.push(`remove:${token}`),
      },
    };
    flashSettingRow(element);
    // The reflow read must sit between the remove and the add, or re-flashing
    // the same row does nothing.
    assert.deepEqual(calls, [
      "scroll:center",
      "remove:sand-settings-row--flash",
      "reflow",
      "add:sand-settings-row--flash",
    ]);

    assert.doesNotThrow(() => flashSettingRow(null));
    assert.equal(flashSettingRowByKey({ getElementById: () => null }, "missing"), false);
    assert.equal(flashSettingRowByKey({ getElementById: () => element }, "theme"), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
