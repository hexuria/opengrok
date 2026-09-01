import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as patch from "../scripts/lib/router-renderer-patch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = patch.COMPONENT_SOURCE;

test("the rules list lives in the app's own dialog, not a hand-rolled one", () => {
  // Os is the same Dialog primitive that renders the Settings modal, and Te
  // its scroll pane. Reusing them is what makes the modal match the app in
  // both themes with no new CSS - the whole point of this change.
  assert.match(src, /a\.jsx\(Os,\{"aria-label":"Standing rules"/);
  assert.match(src, /a\.jsx\(Os,\{"aria-label":"Standing rules",open:!!open,onOpenChange:[^,]+,size:"md"/,
    "md must be the dialog's size (Settings uses xxl); a bare /size:\"md\"/ also matches the title text");
  // Te is the settings *page* pane: it only constrains height as a flex
  // child and carries page padding, so with 40 rules the list overflowed
  // instead of scrolling. The dialog owns its scroll box now.
  assert.match(src, /id:panelId,role:"tabpanel"[\s\S]{0,320}overflowY:"auto"/,
    "the rules panel itself must be the scroll box");
  // Check the property, not one character sequence: nothing inside the modal
  // component may use the settings page pane, whatever shape it takes.
  const modal = src.slice(src.indexOf("function RStandingRules("), src.indexOf("function RRemoteControl("));
  assert.ok(modal.length > 500, "RStandingRules body must be locatable");
  assert.doesNotMatch(modal, /a\.jsxs?\(Te,/, "the rules modal must not use the settings page pane anywhere");
  // No bespoke surface: no invented radius, shadow or backdrop for this modal.
  assert.doesNotMatch(src, /sand-standing-rules[\s\S]{0,200}box-shadow/);
});

test("tabs are real tabs and the close control is the app's icon button", () => {
  assert.match(src, /role:"tablist"/);
  assert.match(src, /a\.jsx\(oe,\{role:"tab","aria-selected":tab===id/);
  assert.match(src, /tabButton\("allow","Allow",allow\.length\)/);
  assert.match(src, /tabButton\("deny","Never",deny\.length\)/, "copy says Never, matching the mode picker and the old row");
  assert.match(src, /a\.jsx\(\$e,\{icon:"close"/);
  // Roving tabindex is only legal with arrow-key movement; without it the
  // unfocused tab is unreachable from the keyboard.
  assert.match(src, /tabIndex:tab===id\?0:-1/);
  assert.match(src, /onKeyDown:onTablistKey/);
  assert.match(src, /ev\.key==="ArrowRight"/);
  assert.match(src, /"aria-controls":panelId/);
  assert.match(src, /id:panelId,role:"tabpanel"[^}]*tabIndex:0/, "the scroll box must be keyboard focusable");
  // A list may only own listitems: the empty message sits outside it.
  assert.doesNotMatch(src, /role:"list"[^)]{0,200}:a\.jsx\(se,\{as:"p"/, "empty message must not be a child of role=list");
});

test("the filter reuses the shared input styling and narrows the list", () => {
  assert.match(src, /"aria-label":"Filter commands",className:RRouterInputClass/,
    "must be the filter input reusing the shared styling, not any input in the file");
  assert.match(src, /placeholder:"Filter commands…"/);
  assert.match(src, /"aria-label":"Filter commands"/);
  assert.match(src, /rules\.filter\(function\(p\)\{return p\.toLowerCase\(\)\.includes\(needle\)\}\)/);
  // Height derives from the tab's UNFILTERED count, so typing cannot resize
  // the dialog, and a two-rule list does not leave a tall empty well.
  assert.match(src, /height:"min\(38vh, "\+Math\.max\(96,rules\.length\*38\)\+"px\)"/);
  assert.doesNotMatch(src, /Math\.max\(96,shown\.length/, "must not depend on the filtered count");
});

test("the settings row is a summary plus Manage…, not the whole list", () => {
  assert.match(src, /label:"Standing rules",\s*\n?\s*description:RStandingSummary\(s\.allow\.length,s\.deny\.length\)/);
  assert.match(src, /children:"Manage…"/);
  assert.match(src, /disabled:s\.allow\.length\+s\.deny\.length===0/, "nothing to manage when there are no rules");
  // The old inline dump of every rule into the card is gone.
  assert.doesNotMatch(src, /\.\.\.s\.allow\.map\(function\(p\)\{return RRuleRow/);
});

test("summary counts read naturally and delete keeps its contract", () => {
  assert.match(src, /total===1\?" rule":" rules"/);
  assert.match(src, /" allow, "\+deny\+" never/);
  // Same backend call and (kind, pattern) pair as before - no new semantics.
  assert.match(src, /window\.desktop\.agent\.deleteRemoteControlRule\(kind,pattern\)/);
  // Opening clears any stale error, and the page does not duplicate the
  // modal's error while the modal is open.
  assert.match(src, /managing:!0,error:null/);
  assert.match(src, /s\.error&&!s\.managing\?a\.jsx\(se/);
  assert.match(src, /:"No rules match that filter\."/);
  assert.match(src, /"No commands are always allowed yet\."/);
});

test("boolean settings use the bundle's Switch rather than a copy of it", async () => {
  assert.doesNotMatch(src, /const RSwitch=/, "the hand-rolled switch is retired");
  assert.doesNotMatch(src, /RSwitchTrackOn|RSwitchKnob/, "and so are its borrowed class strings");
  assert.match(src, /a\.jsx\(Ne,\{label:"Allow administrator \(sudo\) commands",isChecked:/);

  // Every symbol used here must exist where this source is spliced; the
  // dedicated guard test proves it, this just names the ones we added.
  const assetsRoot = path.join(repoRoot, "src/app/dist/renderer/assets");
  const panelPath = path.join(assetsRoot, "index-BlqerJhg.js");
  const panel = await readFile(panelPath, "utf8").catch(() => null);
  if (panel == null) return; // pinned renderer is recovered by bootstrap, absent in CI
  // They arrive as import aliases (`ci as Os`, `aa as $e`, …), so match the
  // binding rather than a word boundary - $ is not a word character.
  for (const id of ["Os", "Te", "Ne", "ts", "$e"]) {
    assert.ok(panel.includes(` as ${id},`) || panel.includes(` as ${id}}`), `${id} must be imported into the settings panel chunk`);
  }
});
