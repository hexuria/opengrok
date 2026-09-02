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
// unchanged. The same is true if the bridge is missing, or the server refuses
// the read OR the write: falling back to the global list is worse than
// per-coworker but far better than dropping a rule the person was told was
// saved. The settled note says where the rule actually went, not where the
// mode flag suggested it might.

/** The flag the app already keeps in sync with the box runtime; written by the OpenGrok-mode helper. */
export const OPENGROK_MODE_STORAGE_KEY = "sand-opengrok-mode";

/** The upstream caps on the allow list: 20 rules of 1000 characters (`H9e`/`CBe`). Kept identical so neither tier can outgrow the other. */
export const ALLOW_RULE_CEILING = 20;
export const ALLOW_RULE_MAX_CHARS = 1000;

const CALL_BEFORE = "loadAlwaysAllow:()=>de(r.autoReviewInstructions,N)";
const CALL_AFTER = "loadAlwaysAllow:()=>de(r.autoReviewInstructions,N,s)";

const DE_BEFORE =
  'async function de(t,e){if(e===void 0)return"approved";try{await t.load();const s=ne(t.snapshots.get());'
  + 'return s==null?"approved":(await t.setInstructions(W(s,e)),"always")}catch{return"approved"}}';

// The settled note, whole, so it can be keyed on where the rule went rather than on the mode.
const NOTE_BEFORE =
  'function ue(t,e){if(t!=="always")return;const s="A rule always allowing this was added to your Auto-review settings";'
  + 'return e===void 0?s:`${s}: “${e}”`}';
const NOTE_AFTER =
  'function ue(t,e){if(t!=="always")return;'
  + 'const s=__sandAllowScope.get(e)==="coworker"'
  + '?"A rule always allowing this was added to this coworker’s Auto-review settings"'
  + ':"A rule always allowing this was added to your Auto-review settings";'
  + 'return e===void 0?s:`${s}: “${e}”`}';

/** True when an OpenGrok server owns the policy, so a coworker tier exists to write to. */
const MODE_HELPER =
  'function __sandPerCoworkerAllow(){try{return localStorage.getItem('
  + JSON.stringify(OPENGROK_MODE_STORAGE_KEY)
  + ')==="1"}catch(_){return!1}}';

// Where each accepted rule went, keyed by the rule text the note is given. Module-scoped, so a
// reload forgets it and the note falls back to upstream's wording — stated in the tests.
const SCOPE_STATE = "var __sandAllowScope=new Map();";

// Reads the coworker's row, appends the rule, writes the whole row back. The PUT is whole-row,
// so the block list is carried through or it is erased; null there means "inherit", which is
// not the same as empty, so null is preserved.
//
// The allow list needs more care. A coworker with no allow list of its own INHERITS the global
// tier, and precedence on the server is per field: once this coworker has an allow list, the
// global one no longer applies to it. Writing just the new rule would silently strip every
// inherited rule from this coworker. So an inheriting coworker's list is seeded from the
// EFFECTIVE allow list the server reports (`/auto-review/effective`) before the rule is added —
// a snapshot, taken the moment the person clicks. Rules added globally later do not reach this
// coworker; that is the price of a per-coworker rule under per-field precedence, and it is a
// server design, not a client choice.
const WRITE_HELPER =
  'async function __sandAlwaysAllowForCoworker(id,rule){'
  + 'if(typeof id!=="string"||id.length===0||typeof rule!=="string")return!1;'
  + 'rule=rule.trim();if(rule.length===0)return!1;'
  + 'if(rule.length>' + ALLOW_RULE_MAX_CHARS + ')rule=rule.slice(0,' + ALLOW_RULE_MAX_CHARS + ');'
  + 'if(!__sandPerCoworkerAllow())return!1;'
  + 'var bridge=globalThis.desktop&&globalThis.desktop.agent;'
  + 'if(!bridge||typeof bridge.getAgentAutoReview!=="function"||typeof bridge.setAgentAutoReview!=="function")return!1;'
  + 'try{'
  + 'var current=await bridge.getAgentAutoReview(id);'
  + 'if(!current||current.available!==!0||typeof current.error==="string")return!1;'
  + 'var row=current.row||{};'
  + 'var rows=function(v){return Array.isArray(v)?v.slice():typeof v==="string"?v.split("\\n").map(function(x){return x.trim()}).filter(Boolean):null};'
  + 'var own=rows(row.allowInstructions);'
  + 'var inherited=own===null&&current.effective?rows(current.effective.allowInstructions):null;'
  + 'var allow=own!==null?own:inherited!==null?inherited:[];'
  + 'if(allow.indexOf(rule)!==-1)return!0;'
  + 'var next=allow.concat([rule]);'
  + 'if(next.length>' + ALLOW_RULE_CEILING + ')next=next.slice(next.length-' + ALLOW_RULE_CEILING + ');'
  + 'await bridge.setAgentAutoReview(id,{enabled:typeof row.enabled==="boolean"?row.enabled:null,'
  + 'allowInstructions:next,blockInstructions:rows(row.blockInstructions)});'
  + 'return!0'
  + '}catch(_){return!1}}';

const DE_AFTER =
  SCOPE_STATE + MODE_HELPER + WRITE_HELPER
  + 'async function de(t,e,coworkerId){if(e===void 0)return"approved";try{'
  + 'if(await __sandAlwaysAllowForCoworker(coworkerId,e)){__sandAllowScope.set(e,"coworker");return"always"}'
  + 'await t.load();const s=ne(t.snapshots.get());if(s==null)return"approved";'
  + 'await t.setInstructions(W(s,e));__sandAllowScope.set(e,"global");return"always"}catch{return"approved"}}';

/** Every anchor this patch needs, so a caller can find the chunk by content instead of by hash. */
export const ALWAYS_ALLOW_ANCHORS = [CALL_BEFORE, DE_BEFORE, NOTE_BEFORE];

function replaceExactlyOnce(source, before, after, what) {
  // split/join, not String.replace: a `$` in the replacement would otherwise be read as a pattern.
  const parts = source.split(before);
  if (parts.length !== 2) throw new Error(`Always-allow anchor for ${what} matched ${parts.length - 1} times, expected exactly 1`);
  return parts.join(after);
}

/** Route the card's "Always allow" to the coworker's own allow list when a server holds one. */
export function patchOriginalAlwaysAllowScope(source) {
  if (source.includes("__sandAlwaysAllowForCoworker")) return source;
  let patched = replaceExactlyOnce(source, DE_BEFORE, DE_AFTER, "the always-allow writer");
  patched = replaceExactlyOnce(patched, CALL_BEFORE, CALL_AFTER, "the coworker id at the call site");
  return replaceExactlyOnce(patched, NOTE_BEFORE, NOTE_AFTER, "the settled note");
}
