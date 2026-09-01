// Drives the Routines pane of the running Open Grok.app over CDP with REAL input events and
// cross-checks every step against the gateway, so "does the Routines feature work end to end"
// is a two-minute run rather than an afternoon. Steps: open the agent → Create Routine → name +
// instruction → Add trigger → On a schedule → save → listed on the server → edit → Test run →
// run recorded + coworker message → delete → gone.
//
// Usage: node scripts/verify-routines.mjs [--agent <cw_id>] [--discover] [--keep]
//   --discover  stop after opening the editor and print every input and button it offers
//               (use this the first time against a new build to learn the selectors)
//   --keep      do not delete the routine at the end
// Env: OG_GATEWAY_URL (default http://127.0.0.1:1447), OG_GATEWAY_BEARER (required for the
// server cross-checks), CDP_PORT (default 9223). The app must be running with
// --remote-debugging-port. Never a synthetic .click(): menus close on those.
import { clickAt, done, ev, key, sleep } from "../docs/research/tools/cdp-drive.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback; };
const GATEWAY = process.env.OG_GATEWAY_URL ?? "http://127.0.0.1:1447";
const BEARER = process.env.OG_GATEWAY_BEARER;
const NAME = `Verify routine ${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
const INSTRUCTION = "Reply with exactly the word routine-ok.";

const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const fail = (what) => { console.error(`FAIL ${what}`); process.exit(1); };

async function api(method, body) {
  if (!BEARER) return null;
  const res = await fetch(`${GATEWAY}/api/${method}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` }, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let value; try { value = JSON.parse(text); } catch { value = text; }
  return { status: res.status, value };
}

// Everything visible that a person could click or type into, so a step that cannot find its
// target prints what the pane actually offers instead of guessing.
const inventory = () => ev(`(()=>{
  const vis=(n)=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0};
  const buttons=[...document.querySelectorAll("button,[role=button],[role=menuitem],[role=option],a[href]")].filter(vis).map(n=>(n.getAttribute("aria-label")||n.textContent||"").trim().replace(/\\s+/g," ")).filter(Boolean);
  const inputs=[...document.querySelectorAll("input,textarea,select,[contenteditable=true]")].filter(vis).map(n=>({tag:n.tagName.toLowerCase(),type:n.getAttribute("type"),placeholder:n.getAttribute("placeholder"),label:n.getAttribute("aria-label"),value:(n.value??n.textContent??"").slice(0,60)}));
  return {buttons:[...new Set(buttons)].slice(0,60),inputs};
})()`);

// Click the first visible element whose accessible text matches, with a real mouse event.
async function clickText(pattern, role = "button,[role=button],[role=menuitem],[role=option],[role=tab],li,a") {
  const box = await ev(`(()=>{const re=new RegExp(${JSON.stringify(pattern)},"i");const vis=(n)=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0};
    const n=[...document.querySelectorAll(${JSON.stringify(role)})].find(e=>vis(e)&&re.test((e.getAttribute("aria-label")||e.textContent||"").trim()));
    if(!n)return null;n.scrollIntoView({block:"center"});const r=n.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  if (!box) return false;
  await clickAt(box[0], box[1]);
  await sleep(400);
  return true;
}

async function typeInto(selectorExpr, text) {
  const focused = await ev(`(()=>{const n=${selectorExpr};if(!n)return false;n.focus();if(n.tagName==="INPUT"||n.tagName==="TEXTAREA"){n.select&&n.select()}return true})()`);
  if (!focused) return false;
  // execCommand goes through the editable's own input pipeline (React/TipTap see it as typing).
  const ok = await ev(`document.execCommand("insertText",false,${JSON.stringify(text)})`);
  await sleep(200);
  return ok !== false;
}

const bodyHas = (pattern) => ev(`new RegExp(${JSON.stringify(pattern)},"i").test(document.body.innerText)`);

async function waitFor(what, pattern, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await bodyHas(pattern)) return true; await sleep(500); }
  fail(`${what}: did not see /${pattern}/ within ${ms}ms`);
}

// ---- preflight ------------------------------------------------------------------------------
if (await ev(`document.body.innerText.includes("Something went wrong")`)) fail("the app shows its error boundary");
const agentId = opt("--agent", null);
const agentsBefore = BEARER ? await api("listAllAutomations") : null;
log("preflight ok", agentsBefore ? `server automations before: ${Array.isArray(agentsBefore.value) ? agentsBefore.value.length : agentsBefore.status}` : "(no OG_GATEWAY_BEARER: server cross-checks skipped)");

// ---- open the Routines editor ---------------------------------------------------------------
if (agentId) {
  const opened = await api("getAgentTranscriptTail", { id: agentId, limit: 1 });
  log("agent", agentId, "tail status", opened?.status);
}
if (!(await bodyHas("Routines are recurring tasks|Create Routine"))) {
  // The routines section lives in the agent's details; try the obvious ways in.
  await clickText("^Routines$|Open details|Details");
  await sleep(600);
}
if (!(await clickText("^Create Routine$"))) { log("inventory:", JSON.stringify(await inventory())); fail("no Create Routine button visible; open the agent's details first"); }
await sleep(800);
log("editor opened:", JSON.stringify(await inventory()));
if (flag("--discover")) { await clickText("^Back to Routines$|^Close details$"); done(); }

// ---- name + instruction ---------------------------------------------------------------------
if (!(await typeInto(`document.querySelector('input[placeholder="Name this routine"],input[aria-label="Name"]')`, NAME))) fail("name field not found");
if (!(await typeInto(`document.querySelector('textarea[aria-label="Instruction"],textarea[placeholder^="What should this routine"]')`, INSTRUCTION))) fail("instruction field not found");
log("typed name and instruction");

// ---- trigger: On a schedule -----------------------------------------------------------------
if (!(await clickText("^Add trigger$"))) fail("Add trigger not found");
if (!(await clickText("^On a schedule$", "[role=menuitem],[role=option],button,li"))) { log("after Add trigger:", JSON.stringify(await inventory())); fail("On a schedule not offered"); }
await sleep(800);
const schedInv = await inventory();
log("schedule editor:", JSON.stringify(schedInv));
// Fill whatever schedule field appeared; a cron/every field takes text, a preset takes a click.
const cronField = `[...document.querySelectorAll("input,textarea")].find(n=>/cron|schedule|every|when/i.test((n.getAttribute("placeholder")||"")+(n.getAttribute("aria-label")||"")))`;
if (await ev(`!!(${cronField})`)) { await typeInto(cronField, "every 15m"); log("typed schedule"); }
else await clickText("^(Daily|Every day|Hourly|Every hour|Weekdays)");
// Save: whichever of these the editor offers.
if (!(await clickText("^(Save|Done|Create|Add)( routine)?$"))) log("no explicit save button; relying on autosave");
await sleep(1500);

// ---- listed on the server -------------------------------------------------------------------
if (BEARER) {
  const listed = await api("listAllAutomations");
  const mine = Array.isArray(listed.value) ? listed.value.find((r) => r.name === NAME) : null;
  if (!mine) { log("server list:", JSON.stringify(listed.value).slice(0, 400)); fail("routine not listed on the server after create"); }
  log("server has it:", JSON.stringify({ id: mine.id, name: mine.name, trigger: mine.trigger, schedule: mine.schedule, isEnabled: mine.isEnabled, nextRunAt: mine.nextRunAt }));
  // ---- edit -----------------------------------------------------------------------------------
  if (await typeInto(`document.querySelector('textarea[aria-label="Instruction"],textarea[placeholder^="What should this routine"]')`, `${INSTRUCTION} (edited)`)) {
    // The editor autosaves on blur, not on a button: move focus away, then wait for the update
    // to land on the server before doing anything else, so a Test run cannot race the autosave.
    await ev(`(()=>{const n=document.querySelector('input[placeholder="Name this routine"]');n&&n.focus();return true})()`);
    let rows = [];
    for (let i = 0; i < 16; i += 1) {
      await sleep(500);
      const again = await api("listAllAutomations");
      rows = Array.isArray(again.value) ? again.value.filter((r) => r.name === NAME) : [];
      if (rows.length === 1 && /edited/.test(rows[0].prompt ?? "")) break;
    }
    if (rows.length !== 1) fail(`edit made ${rows.length} rows named ${NAME}; expected 1`);
    if (!/edited/.test(rows[0].prompt ?? "")) fail(`prompt not updated on the server within 8s: ${rows[0].prompt}`);
    log("edit applied on the server, one row");
  }
  // ---- test run -------------------------------------------------------------------------------
  if (await clickText("^Test run$")) {
    log("test run clicked; waiting for the run and the coworker message");
    const until = Date.now() + 90000; let run = null;
    while (Date.now() < until) {
      const now = await api("listAllAutomations");
      const row = Array.isArray(now.value) ? now.value.find((r) => r.name === NAME) : null;
      run = row?.runs?.find((x) => x.trigger === "manual" && x.status !== "running") ?? null;
      if (run) break; await sleep(3000);
    }
    if (!run) fail("no finished manual run recorded within 90s");
    log("run recorded:", JSON.stringify(run));
    await waitFor("coworker message", `Routine ${NAME.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")} ran`, 20000);
    log("coworker message rendered in the chat");
  } else log("WARN no Test run button");
  // ---- delete ---------------------------------------------------------------------------------
  if (!flag("--keep")) {
    if (await clickText("^Delete$")) { await sleep(500); await clickText("^(Delete|Confirm|Yes)"); await sleep(1500); }
    const after = await api("listAllAutomations");
    if (Array.isArray(after.value) && after.value.some((r) => r.name === NAME)) fail("routine still listed after delete");
    log("deleted on the server");
  }
}
log("PASS");
done();
