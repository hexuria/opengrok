import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OUTPUT, RECOVERED_CSS, collectAtoms, parseRules, renderStylesheet } from "../scripts/extract-recovered-atoms-css.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const present = existsSync(path.join(repoRoot, RECOVERED_CSS)) && existsSync(path.join(repoRoot, "frontend/src"));

test("recovered CSS parser keeps nested at-rules and skips the ones without selectors", () => {
  const rules = parseRules("@layer reset{html{margin:0}}@property --x{syntax:\"*\"}.a:not(#\\#){display:flex}@media(min-width:1px){.b{gap:1px}}");
  assert.deepEqual(rules.map((rule) => [rule.selector, rule.body, rule.wrap]), [
    ["html", "margin:0", "@layer reset"],
    [".a:not(#\\#)", "display:flex", null],
    [".b", "gap:1px", "@media(min-width:1px)"],
  ]);
});

/**
 * Every atom a ported view names must have its declaration shipped; the mock
 * card catalogue found 267 that did not and drew the box card as bare text.
 * The generated stylesheet is stow-shipped, so the check runs only where the
 * recovered material is restored.
 */
test("every atom the ports name is declared by some frontend stylesheet", { skip: !present }, async () => {
  const { text, wanted, emitted } = renderStylesheet(repoRoot);
  const current = await readFile(path.join(repoRoot, OUTPUT), "utf8");
  assert.equal(current, text, `${OUTPUT} is stale; run node scripts/extract-recovered-atoms-css.mjs`);
  const { used, declared } = collectAtoms(repoRoot);
  // Names that match the atom shape but have no atomic rule are semantic
  // classes (sand-border, sand-mascot); a real atom left undeclared is the bug
  // — `sand-1g0q52` for `sand-1g0q52m` cost the secret-request card its
  // surface, and `sand-1shwlz`/`sand-mix8c` were the same kind of slip.
  const undeclared = [...used].filter((atom) => !declared.has(atom) && !emitted.has(atom) && wanted.has(atom) && /\d/.test(atom));
  assert.deepEqual(undeclared, [], "atoms used by frontend/src with no shipped declaration (a typo in a ported class list?)");
});
