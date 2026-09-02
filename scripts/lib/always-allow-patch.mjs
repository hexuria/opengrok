// "Always allow this command" writes the rule the server proposed into the
// auto-review allow list. Upstream writes it GLOBALLY: one card, and every
// coworker inherits the rule. On an OpenGrok server the policy has a coworker
// tier, and the person answering a card is answering for that coworker, so the
// rule belongs there.
//
// This patches the approval card's own chunk, which is neither of the two the
// rest of the pipeline touches: the card is lazily imported as
// `auto-review-approval/view.tsx`, and its chunk holds the renderer's only use
// of `proposedRule`.
//
// On the Cursor route the coworker tier does not exist (there is no server to
// hold it), so the helper answers false and the original global path runs
// unchanged. The same is true if the bridge is missing or the server refuses:
// falling back to the global list is worse than per-coworker but far better
// than dropping a rule the person was told was saved.

/** The flag the app already keeps in sync with the box runtime; written by the OpenGrok-mode helper. */
export const OPENGROK_MODE_STORAGE_KEY = "sand-opengrok-mode";

/** The upstream cap on the allow list: 20 rules. Kept identical so neither tier can outgrow the other. */
export const ALLOW_RULE_CEILING = 20;

const CALL_BEFORE = "loadAlwaysAllow:()=>de(r.autoReviewInstructions,N)";
const CALL_AFTER = "loadAlwaysAllow:()=>de(r.autoReviewInstructions,N,s)";

const DE_BEFORE =
  'async function de(t,e){if(e===void 0)return"approved";try{await t.load();const s=ne(t.snapshots.get());'
  + 'return s==null?"approved":(await t.setInstructions(W(s,e)),"always")}catch{return"approved"}}';

const NOTE_BEFORE = '"A rule always allowing this was added to your Auto-review settings"';
const NOTE_AFTER =
  '(__sandPerCoworkerAllow()?"A rule always allowing this was added to this coworker\'s Auto-review settings"'
  + ':"A rule always allowing this was added to your Auto-review settings")';

/** True when an OpenGrok server owns the policy, so a coworker tier exists to write to. */
const MODE_HELPER =
  'function __sandPerCoworkerAllow(){try{return localStorage.getItem('
  + JSON.stringify(OPENGROK_MODE_STORAGE_KEY)
  + ')==="1"}catch(_){return!1}}';

// Reads the coworker's own row, appends the rule, writes the whole row back —
// the PUT is whole-row, so the block list has to be carried through or it is
// erased. A null list means "inherit", which is not the same as an empty one,
// so null is preserved rather than flattened to [].
const WRITE_HELPER =
  'async function __sandAlwaysAllowForCoworker(id,rule){'
  + 'if(typeof id!=="string"||id.length===0||typeof rule!=="string"||rule.length===0)return!1;'
  + 'if(!__sandPerCoworkerAllow())return!1;'
  + 'var bridge=globalThis.desktop&&globalThis.desktop.agent;'
  + 'if(!bridge||typeof bridge.getAgentAutoReview!=="function"||typeof bridge.setAgentAutoReview!=="function")return!1;'
  + 'var current=await bridge.getAgentAutoReview(id);'
  + 'if(!current||current.available!==!0||typeof current.error==="string")return!1;'
  + 'var row=current.row||{};'
  + 'var rows=function(v){return Array.isArray(v)?v.slice():typeof v==="string"?v.split("\\n").map(function(x){return x.trim()}).filter(Boolean):null};'
  + 'var allow=rows(row.allowInstructions)||[];'
  + 'if(allow.indexOf(rule)!==-1)return!0;'
  + 'var next=allow.concat([rule]);'
  + 'if(next.length>' + ALLOW_RULE_CEILING + ')next=next.slice(next.length-' + ALLOW_RULE_CEILING + ');'
  + 'await bridge.setAgentAutoReview(id,{enabled:typeof row.enabled==="boolean"?row.enabled:null,'
  + 'allowInstructions:next,blockInstructions:rows(row.blockInstructions)});'
  + 'return!0}';

const DE_AFTER =
  MODE_HELPER + WRITE_HELPER
  + 'async function de(t,e,coworkerId){if(e===void 0)return"approved";try{'
  + 'if(await __sandAlwaysAllowForCoworker(coworkerId,e))return"always";'
  + 'await t.load();const s=ne(t.snapshots.get());'
  + 'return s==null?"approved":(await t.setInstructions(W(s,e)),"always")}catch{return"approved"}}';

/** Every anchor this patch needs, so a caller can find the chunk by content instead of by hash. */
export const ALWAYS_ALLOW_ANCHORS = [CALL_BEFORE, DE_BEFORE, NOTE_BEFORE];

function replaceExactlyOnce(source, before, after, what) {
  let count = 0;
  let at = 0;
  while ((at = source.indexOf(before, at)) !== -1) {
    count += 1;
    at += before.length;
  }
  if (count !== 1) throw new Error(`Always-allow anchor for ${what} matched ${count} times, expected exactly 1`);
  return source.replace(before, after);
}

/** Route the card's "Always allow" to the coworker's own allow list when a server holds one. */
export function patchOriginalAlwaysAllowScope(source) {
  if (source.includes("__sandAlwaysAllowForCoworker")) return source;
  let patched = replaceExactlyOnce(source, DE_BEFORE, DE_AFTER, "the always-allow writer");
  patched = replaceExactlyOnce(patched, CALL_BEFORE, CALL_AFTER, "the coworker id at the call site");
  return replaceExactlyOnce(patched, NOTE_BEFORE, NOTE_AFTER, "the settled note");
}
