// Brand by backend: the 0.30 renderer says "Grok Bot" in a hundred strings. Signed in to an
// OpenGrok server the product is "Open Grok", so every such string literal is routed through a
// tiny runtime helper that swaps the name when the page is in OpenGrok mode (the same
// `sand-opengrok-mode` flag the sign-in card and login-wall patches read). This is a build-time
// source transform over real tokens (acorn), not a regex over minified text: a `"` inside a
// template or regex never fools it, object keys and tagged templates are left alone and counted.
import * as acorn from "acorn";

export const BRAND_SOURCE_NAME = "Grok Bot";
export const BRAND_HELPER_NAME = "__sandBrandText";
export const OPENGROK_MODE_STORAGE_KEY = "sand-opengrok-mode";

/** Strings that name the *official* product or its builds stay as they are, whatever the mode. */
export const BRAND_KEEP_PATTERNS = [/official Grok Bot/i, /Grok Bot Lab/, /Grok Bot Helper/];
/** ...and so does a literal in these positions: the first-run card for the Cursor backend names the official product. */
export const BRAND_KEEP_BEFORE = [/label:"Cursor",title:$/];
/** Keywords a class member key may follow: `get "x"(){}`, `async "x"(){}`. */
const KEY_PREFIX_KEYWORDS = new Set(["get", "set", "static", "async"]);

export const BRAND_HELPER_SOURCE =
  `var ${BRAND_HELPER_NAME}=(function(){var on=null,at=0;return function(s){`
  + `var now=Date.now();if(on===null||now-at>1000){at=now;try{on=localStorage.getItem(${JSON.stringify(OPENGROK_MODE_STORAGE_KEY)})==="1"}catch(_){on=!1}}`
  + `return on&&typeof s==="string"?s.replace(/Grok Bot/g,"Open Grok"):s}})();`
  // The window title comes from the static <title> in index.html, which no string literal owns
  // (and the CSP keeps inline scripts out of the HTML), so the first chunk to load syncs it.
  + `;(function(){try{if(self.__sandBrandTitleSynced)return;self.__sandBrandTitleSynced=!0;`
  + `var f=function(){try{if(localStorage.getItem(${JSON.stringify(OPENGROK_MODE_STORAGE_KEY)})==="1"&&document.title==="Grok Bot")document.title="Open Grok"}catch(_){}};`
  + `f();var t=document.querySelector("title");if(t&&typeof MutationObserver==="function")new MutationObserver(f).observe(t,{childList:!0,characterData:!0,subtree:!0});setInterval(f,15e3)}catch(_){}})();`;

function keep(value) {
  return BRAND_KEEP_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Rewrite every string literal and template text that mentions the brand so it goes through the
 * runtime helper. Returns the new source plus what was done, so a build can log and a test can
 * pin the counts. Idempotent: a source that already carries the helper is returned unchanged.
 */
export function patchOriginalBrandText(source) {
  if (!source.includes(BRAND_SOURCE_NAME)) return { source, wrapped: 0, templates: 0, kept: 0, skippedKeys: 0, skippedTagged: 0 };
  if (source.includes(`var ${BRAND_HELPER_NAME}=`)) return { source, wrapped: 0, templates: 0, kept: 0, skippedKeys: 0, skippedTagged: 0, already: true };
  const tokens = [];
  for (const token of acorn.tokenizer(source, { ecmaVersion: "latest", sourceType: "module" })) tokens.push(token);
  const edits = [];
  let wrapped = 0, templates = 0, kept = 0, skippedKeys = 0, skippedTagged = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const label = token.type.label;
    if (label === "string") {
      if (typeof token.value !== "string" || !token.value.includes(BRAND_SOURCE_NAME)) continue;
      if (keep(token.value) || BRAND_KEEP_BEFORE.some((pattern) => pattern.test(source.slice(Math.max(0, token.start - 48), token.start)))) { kept += 1; continue; }
      const previous = tokens[index - 1];
      const previousLabel = previous?.type.label;
      const next = tokens[index + 1]?.type.label;
      // A property key, however it is written: {"x":1}, class C{"x"(){}}, {get "x"(){}}.
      if (next === ":" && (previousLabel === "{" || previousLabel === ",")) { skippedKeys += 1; continue; }
      // `get`/`set`/`static`/`async` are plain names to the tokenizer, so match their text.
      const previousText = previous == null ? "" : source.slice(previous.start, previous.end);
      if (next === "(" && (previousLabel === "{" || previousLabel === "}" || previousLabel === ";"
        || previousLabel === "," || KEY_PREFIX_KEYWORDS.has(previousText))) { skippedKeys += 1; continue; }
      // A module specifier is a path, not copy: rewriting it would break the import.
      if (previousLabel === "import" || (previousLabel === "(" && tokens[index - 2]?.type.label === "import")) continue;
      if (previousText === "from") continue;
      // Minified code writes `return"x"` with no space; without one the call glues onto the
      // keyword and becomes `return__sandBrandText("x")`, which parses and then throws at runtime.
      const glued = previous != null && /[\p{ID_Continue}$]/u.test(source[token.start - 1] ?? "");
      edits.push({ start: token.start, end: token.end, text: `${glued ? " " : ""}${BRAND_HELPER_NAME}(${source.slice(token.start, token.end)})` });
      wrapped += 1;
      continue;
    }
    if (label === "template") {
      const raw = source.slice(token.start, token.end);
      if (!raw.includes(BRAND_SOURCE_NAME)) continue;
      if (keep(raw)) { kept += 1; continue; }
      // Walk back to this template's opening backquote; the token before it is the tag, if any.
      // Walk back to this template's opening backquote. Only the `}` that closes an
      // interpolation may cancel a `${`; a block or object brace inside one must not, or the
      // walk runs off the front and a tagged template is mistaken for a plain one.
      let open = index - 1;
      let interpolations = 0;
      let braces = 0;
      for (; open >= 0; open -= 1) {
        const l = tokens[open].type.label;
        if (l === "}") braces += 1;
        else if (l === "{") { if (braces > 0) braces -= 1; }
        else if (l === "${") { if (braces > 0) braces -= 1; else if (interpolations > 0) interpolations -= 1; }
        else if (l === "`" && interpolations === 0 && braces === 0) break;
      }
      const tag = open > 0 ? tokens[open - 1].type.label : null;
      const tagged = tag === "name" || tag === ")" || tag === "]" || tag === "this" || tag === "super";
      if (tagged) { skippedTagged += 1; continue; }
      edits.push({ start: token.start, end: token.end, text: raw.replaceAll(BRAND_SOURCE_NAME, `\${${BRAND_HELPER_NAME}(${JSON.stringify(BRAND_SOURCE_NAME)})}`) });
      templates += 1;
    }
  }
  if (edits.length === 0) return { source, wrapped, templates, kept, skippedKeys, skippedTagged };
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  out += source.slice(cursor);
  return { source: `${BRAND_HELPER_SOURCE}\n${out}`, wrapped, templates, kept, skippedKeys, skippedTagged };
}
