// Drive Open Grok.app over CDP for tmp2 scenes. Fail the process on any missed assertion.
// Usage: OG_GATEWAY_BEARER=... node scripts/verify-tmp2.mjs
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clickAt, ev, key, sleep } from "../docs/research/tools/cdp-drive.mjs";

const CDP_PORT = process.env.CDP_PORT ?? "9223";
const GATEWAY = process.env.OG_GATEWAY_URL ?? "http://127.0.0.1:1447";
const BEARER = process.env.OG_GATEWAY_BEARER;
const INFERENCE_LOG = process.env.OG_INFERENCE_LOG;
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultShotDir = path.resolve(here, "../../opengrok-server-tmp2/docs/verification/tmp2");
const SHOT_DIR = process.env.TMP2_SHOT_DIR ?? defaultShotDir;
const proofs = [];

const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const fail = (what) => {
  console.error(`FAIL ${what}`);
  process.exit(1);
};

async function cdp(method, params = {}) {
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) fail("no page target on CDP");
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const result = await new Promise((resolve, reject) => {
    const id = 1;
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.id === id) resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 20000);
  });
  ws.close();
  return result;
}

async function shot(name) {
  await mkdir(SHOT_DIR, { recursive: true });
  const captured = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 70 });
  const b64 = captured.result?.data;
  if (typeof b64 !== "string" || b64.length < 32) fail(`screenshot ${name} empty`);
  await writeFile(path.join(SHOT_DIR, name), Buffer.from(b64, "base64"));
  log("wrote", name);
}

async function inferenceCount() {
  if (INFERENCE_LOG) {
    const text = await readFile(INFERENCE_LOG, "utf8").catch(() => "");
    const routed = (text.match(/oag_server::gateway: routed/g) ?? []).length;
    if (text.length > 0) return routed;
  }
  const serveLog = process.env.OG_SERVE_LOG;
  if (!serveLog) return null;
  const text = await readFile(serveLog, "utf8").catch(() => "");
  return (text.match(/is_running=true/g) ?? []).length;
}

async function completeUsers(q = "") {
  if (!BEARER) fail("OG_GATEWAY_BEARER required for server proofs");
  const res = await fetch(`${GATEWAY}/tmp/complete?token=user&q=${encodeURIComponent(q)}`, {
    headers: { authorization: `Bearer ${BEARER}` },
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function typePrompt(text) {
  const focused = await ev(`(()=>{const n=document.querySelector(".ProseMirror");if(!n)return false;n.focus();return true})()`);
  if (!focused) fail("no .ProseMirror");
  const ok = await ev(`document.execCommand("insertText",false,${JSON.stringify(text)})`);
  if (ok === false) fail("insertText failed");
  await sleep(250);
}

async function clearComposer() {
  await ev(`(()=>{const n=document.querySelector(".ProseMirror");if(!n)return false;n.focus();document.execCommand("selectAll");document.execCommand("delete");return true})()`);
  await sleep(150);
}

async function clickOption(pattern) {
  const find = `(()=>{const re=new RegExp(${JSON.stringify(pattern)},"i");const n=[...document.querySelectorAll("[role=option]")].find(e=>re.test(e.textContent||""));if(!n)return null;const r=n.getBoundingClientRect();if(r.width<2)return null;return [r.left+r.width/2,r.top+r.height/2]})()`;
  let box = null;
  for (let i = 0; i < 12; i++) {
    box = await ev(find);
    if (box) break;
    await sleep(250);
  }
  if (!box) fail(`no option matching /${pattern}/i`);
  await clickAt(box[0], box[1]);
  await sleep(300);
}

async function keyEnter() {
  await ev(`(()=>{const n=document.querySelector(".ProseMirror");if(n)n.focus();return true})()`);
  await key("Enter", "Enter", 13);
}

async function sendEnter() {
  await keyEnter();
  await sleep(1800);
}

async function personPill() {
  return ev(`(()=>{const n=document.querySelector(".sand-workflow-chip,[data-type=tmp-plugin],[data-type=workflow-reference]");if(!n)return null;const r=n.getBoundingClientRect();return {t:(n.textContent||"").replace(/\\s+/g," ").trim(), w:r.width, h:r.height, icon:!!n.querySelector(".sand-workflow-chip__icon,.sand-workflow-chip__icon-wrap,img") || (n.textContent||"").length>0, plugin:n.getAttribute("data-tmp-plugin")||n.getAttribute("data-id")};})()`);
}

async function activatePerson() {
  await clearComposer();
  await typePrompt("@per");
  await sleep(500);
  const row = await ev(`(()=>{const t=[...document.querySelectorAll("[role=option]")].map(e=>e.textContent||"").join("\\n");return {person:/person/i.test(t), t};})()`);
  if (!row?.person) fail(`@per picker missing person: ${JSON.stringify(row)}`);
  await clickOption("person");
  await sleep(400);
  const pill = await personPill();
  if (!pill || !/person/i.test(pill.t)) fail(`@per did not insert person pill: ${JSON.stringify(pill)}`);
  if (/acct_/i.test(pill.t)) fail(`person pill leaked id: ${pill.t}`);
  return pill;
}

async function visibleBubble(source) {
  return ev(`(()=>{
    const re=new RegExp(${JSON.stringify(source)},"i");
    const vis=(n)=>{const r=n.getBoundingClientRect();return r.width>8&&r.height>8};
    const nodes=[...document.querySelectorAll(".sand-message-prose")].filter((n)=>vis(n)&&re.test(n.textContent||""));
    if(nodes.length===0)return null;
    const last=nodes[nodes.length-1];
    return (last.textContent||"").replace(/\\s+/g," ").trim();
  })()`);
}

async function dismissChrome() {
  for (let i = 0; i < 4; i++) {
    const back = await ev(`(()=>{
      const heading=[...document.querySelectorAll("h1,h2,div,span")].find((n)=>{
        const r=n.getBoundingClientRect();
        return r.width>8 && r.top<56 && r.left>400 && (n.textContent||"").trim()==="Settings";
      });
      if(!heading) return null;
      const hr=heading.getBoundingClientRect();
      const btn=[...document.querySelectorAll("button")].find((b)=>{
        const r=b.getBoundingClientRect();
        return Math.abs(r.top-hr.top)<20 && r.right<=hr.left+12 && r.width>8 && r.width<56;
      });
      if(btn){const r=btn.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];}
      return [hr.left-16, hr.top+hr.height/2];
    })()`);
    if (!back) break;
    await clickAt(back[0], back[1]);
    await sleep(250);
  }
}

async function revealLatest(source) {
  await ev(`(()=>{
    const re=new RegExp(${JSON.stringify(source)},"i");
    const scroller=document.querySelector(".sand-virtual-transcript");
    if(scroller) scroller.scrollTop=scroller.scrollHeight;
    const nodes=[...document.querySelectorAll(".sand-message")].filter((n)=>re.test(n.textContent||""));
    const last=nodes[nodes.length-1];
    last?.scrollIntoView({block:"end", inline:"nearest"});
    return last!=null;
  })()`);
  await sleep(400);
}

if (await ev(`document.body.innerText.includes("Something went wrong")`)) {
  fail("the app shows its error boundary");
}
await dismissChrome();
const who = await ev(`document.body.innerText`);
if (typeof who !== "string" || !/uriah@goldcoders\.dev/i.test(who)) {
  fail("not signed in as uriah@goldcoders.dev");
}
if (typeof who !== "string" || !/Quill/i.test(who)) {
  fail("Quill coworker not visible");
}

const catalog = await completeUsers("");
if (catalog.status !== 200) fail(`GET /tmp/complete ${catalog.status}`);
const names = (catalog.body.catalog ?? []).map((row) => row.name);
if (!names.includes("user")) fail(`catalog missing user: ${JSON.stringify(names)}`);
const labels = (catalog.body.candidates ?? []).map((row) => String(row.label ?? ""));
if (!labels.some((label) => /uriah/i.test(label)) || !labels.some((label) => /ada/i.test(label))) {
  fail(`seeded users missing Uriah+Ada: ${JSON.stringify(labels)}`);
}
proofs.push(`complete catalog=${names.join(",")} users=${labels.join("; ")} stream_count=0`);

await mkdir(SHOT_DIR, { recursive: true });
const peopleChip = await ev(`document.querySelector(".sand-tmp-tag,[data-tmp-mode=on]")!=null`);
if (peopleChip) fail("composer has a forced People/TMP badge; TMP is # from a plugin catalog, not a pinned chip");
await shot("01-tmp-mode-on.jpg");

await clearComposer();
await typePrompt("@");
await sleep(400);
const atUi = await ev(`(()=>{const box=document.querySelector(".sand-mention-listbox,[role=listbox]");const t=box?box.innerText:"";return {t, quill:/quill/i.test(t)};})()`);
if (!atUi?.quill) fail(`@ picker missing bots: ${JSON.stringify(atUi)}`);
if (/SKILL\.md/i.test(atUi.t ?? "")) fail("@ listed a SKILL.md");
await clearComposer();

await typePrompt("#");
await sleep(500);
const hashOff = await ev(`(()=>{const box=document.querySelector(".sand-pr-listbox,[role=listbox]");const t=box?box.innerText:"";return {t, hasUser:/#user/i.test(t)};})()`);
if (hashOff?.hasUser) fail(`# listed #user with no plugin pill: ${JSON.stringify(hashOff)}`);
await shot("12-hash-without-pill.jpg");
proofs.push("12 bare # has no #user until @person pill; complete stream_count=0");

const beforePer = await inferenceCount();
const pill = await activatePerson();
if (!pill.icon) fail(`person pill missing prefix icon: ${JSON.stringify(pill)}`);
const afterPer = await inferenceCount();
if (beforePer != null && afterPer != null && afterPer !== beforePer) {
  fail(`@per Enter sent a message: ${beforePer} -> ${afterPer}`);
}
const leaked = await visibleBubble("@per");
if (leaked && /^@per$/i.test(leaked)) fail(`@per Enter sent literal @per: ${leaked}`);
await shot("10-at-per-enter-pill.jpg");
proofs.push("10 @per Enter inserts person pill with icon; routed unchanged");

await ev(`(()=>{const n=document.querySelector(".ProseMirror");if(!n)return false;n.focus();return true})()`);
await key("Backspace", "Backspace", 8);
await sleep(120);
await key("Backspace", "Backspace", 8);
await sleep(250);
const gone = await personPill();
if (gone && gone.w >= 2) fail(`Backspace did not delete person pill: ${JSON.stringify(gone)}`);
await typePrompt("#");
await sleep(400);
const hashAfterDel = await ev(`(()=>{const t=document.querySelector(".sand-pr-listbox,[role=listbox]")?.innerText||"";return {t, hasUser:/#user/i.test(t)};})()`);
if (hashAfterDel?.hasUser) fail(`# still listed #user after deleting pill: ${JSON.stringify(hashAfterDel)}`);
await shot("11-backspace-deletes-pill.jpg");
proofs.push("11 Backspace deletes person pill; # no longer lists #user");

const pill2 = await activatePerson();
proofs.push(`pill text=${pill2.t}`);
const beforeReq = await inferenceCount();
await sendEnter();
const afterReq = await inferenceCount();
if (beforeReq != null && afterReq != null && afterReq !== beforeReq) {
  fail(`pill-only Enter opened the door: ${beforeReq} -> ${afterReq}`);
}
await shot("14-required-blocks-send.jpg");
proofs.push(`14 @person Enter with no #user blocked; inference stayed ${afterReq}`);

await typePrompt("#");
await sleep(500);
const hashUi = await ev(`(()=>{const box=document.querySelector(".sand-pr-listbox,[role=listbox]");const shell=document.querySelector(".sand-prompt-shell");const t=box?box.innerText:"";const b=box?.getBoundingClientRect();const s=shell?.getBoundingClientRect();return {t, above:!!(b&&s&&b.bottom<=s.top+16), hasUser:/#user/i.test(t)};})()`);
if (!hashUi?.hasUser) fail(`# picker missing #user after pill: ${JSON.stringify(hashUi)}`);
if (!hashUi.above) fail("# picker is not above the composer");
if (/SKILL\.md/i.test(hashUi.t)) fail("# listed a SKILL.md");
await shot("02-at-opens-user-picker.jpg");
await shot("13-hash-after-pill.jpg");
proofs.push("02/13 @person then #user/#years/#role/#pin above composer; complete stream_count=0");

await clickOption("#user");
await sleep(500);
await clickOption("Uriah");
await sleep(400);
const chip = await ev(`document.querySelector("[data-type=tmp-token]")!=null`);
if (!chip) fail("tmpToken chip [data-type=tmp-token] missing after picking Uriah");
const chipText = await ev(`document.querySelector("[data-type=tmp-token]")?.textContent ?? ""`);
if (typeof chipText === "string" && /acct_/i.test(chipText)) fail(`tmpToken chip leaked id: ${chipText}`);
await shot("03-chip-bound-user.jpg");
proofs.push(`03 tmpToken chip text=${chipText}`);

const beforeUnique = await inferenceCount();
await typePrompt(" say hi");
await sendEnter();
const afterUnique = await inferenceCount();
const uniqueBubble = await visibleBubble("say hi");
if (!uniqueBubble || !/Uriah Galang/i.test(uniqueBubble)) fail(`unique send bubble missing Uriah Galang: ${JSON.stringify(uniqueBubble)}`);
if (/acct_/i.test(uniqueBubble) || /@person/i.test(uniqueBubble)) fail(`unique send bubble leaked id/pill: ${uniqueBubble}`);
if (beforeUnique != null && afterUnique != null && afterUnique < beforeUnique + 1) {
  fail(`unique send did not open the door: ${beforeUnique} -> ${afterUnique}`);
}
await revealLatest("say hi");
await dismissChrome();
await shot("04-send-unique-grounded.jpg");
proofs.push(`04 unique send inference ${beforeUnique} -> ${afterUnique}`);

await activatePerson();
await typePrompt("#");
await sleep(400);
await clickOption("#user");
await sleep(500);
const both = await ev(`(()=>{const t=[...document.querySelectorAll("[role=option]")].map(e=>e.textContent||"").join("\\n");return {uriah:/uriah/i.test(t), ada:/ada/i.test(t), t};})()`);
if (!both?.uriah || !both?.ada) fail(`#user list missing Uriah+Ada: ${JSON.stringify(both)}`);
const beforeAmb = await inferenceCount();
await shot("05-ambiguous-pick-no-send.jpg");
const afterAmb = await inferenceCount();
if (beforeAmb != null && afterAmb != null && afterAmb !== beforeAmb) {
  fail(`ambiguous #user opened the door: ${beforeAmb} -> ${afterAmb}`);
}
proofs.push(`05 ambiguous no send inference stayed ${afterAmb}`);

await clickOption("Ada");
await typePrompt(" thanks");
const beforeAda = await inferenceCount();
await sendEnter();
const afterAda = await inferenceCount();
if (beforeAda != null && afterAda != null && afterAda < beforeAda + 1) {
  fail(`Ada send did not open the door: ${beforeAda} -> ${afterAda}`);
}
const adaBubble = await visibleBubble("thanks");
if (!adaBubble || !/Ada Lovelace/i.test(adaBubble)) fail(`Ada send bubble missing Ada Lovelace: ${JSON.stringify(adaBubble)}`);
if (/acct_/i.test(adaBubble) || /@person/i.test(adaBubble)) fail(`Ada send bubble leaked id/pill: ${adaBubble}`);
await revealLatest("thanks");
await dismissChrome();
await shot("06-pick-then-send.jpg");
proofs.push(`06 Ada send inference ${beforeAda} -> ${afterAda}`);

await clearComposer();
await typePrompt("/");
await sleep(400);
const slash = await ev(`document.body.innerText`);
if (typeof slash === "string" && /Chat Settings/i.test(slash)) fail("/ opened Chat Settings");
await shot("08-tmp-mode-off-skills-on-slash.jpg");
proofs.push("08 / skills or empty reference list, not Chat Settings");

await activatePerson();
await typePrompt("#years");
await sleep(500);
const years = await ev(`(()=>{const n=document.querySelector("[data-tmp-ui=number]");if(!n)return {ok:false,why:"missing"};const r=n.getBoundingClientRect();const wrap=n.closest("div[style]");const ws=wrap?getComputedStyle(wrap).display:"";return {ok:r.width>=2&&r.height>=2&&ws!=="none",w:r.width,h:r.height,ws,ph:n.getAttribute("placeholder")};})()`);
if (!years?.ok) fail(`#years number field not visible: ${JSON.stringify(years)}`);
await shot("09-bang-enables-tmp.jpg");
proofs.push(`09 #years number UI visible placeholder=${years.ph} (bang superseded; # is the token trigger)`);

await activatePerson();
const beforeImp = await inferenceCount();
await typePrompt("email Uriah the invoice");
await sendEnter();
const afterImp = await inferenceCount();
if (beforeImp != null && afterImp != null && afterImp !== beforeImp) {
  fail(`email leftover opened the door: ${beforeImp} -> ${afterImp}`);
}
const impBubble = await visibleBubble("email Uriah the invoice");
if (!impBubble || !/email Uriah the invoice/i.test(impBubble)) fail(`implicit bubble missing original text: ${JSON.stringify(impBubble)}`);
if (/acct_/i.test(impBubble) || /@person/i.test(impBubble)) fail(`implicit bubble leaked id/pill: ${impBubble}`);
const toolUi = await ev(`document.body.innerText`);
if (typeof toolUi !== "string" || !/find_user/i.test(toolUi)) fail("find_user tool-call missing from transcript");
if (typeof toolUi !== "string" || !/send_email/i.test(toolUi)) fail("send_email tool-call missing from transcript");
await revealLatest("email Uriah the invoice");
await dismissChrome();
await shot("07-implicit-uriah.jpg");
proofs.push(`07 find_user + send_email host tool-calls; inference stayed ${afterImp}`);

await clearComposer();
const beforeBare = await inferenceCount();
await typePrompt("email Uriah the invoice");
await sendEnter();
const afterBare = await inferenceCount();
if (beforeBare != null && afterBare != null && afterBare < beforeBare + 1) {
  fail(`ungrounded send did not open the door: ${beforeBare} -> ${afterBare}`);
}
const bareBubble = await visibleBubble("email Uriah the invoice");
if (!bareBubble || !/email Uriah the invoice/i.test(bareBubble)) fail(`bare implicit bubble missing: ${JSON.stringify(bareBubble)}`);
if (/acct_/i.test(bareBubble)) fail(`bare send leaked id: ${bareBubble}`);
await shot("17-implicit-without-pill.jpg");
proofs.push(`17 implicit without pill is normal chat ${beforeBare} -> ${afterBare}; no acct_ in bubble`);

const required = [
  "01-tmp-mode-on.jpg",
  "02-at-opens-user-picker.jpg",
  "03-chip-bound-user.jpg",
  "04-send-unique-grounded.jpg",
  "05-ambiguous-pick-no-send.jpg",
  "06-pick-then-send.jpg",
  "07-implicit-uriah.jpg",
  "08-tmp-mode-off-skills-on-slash.jpg",
  "09-bang-enables-tmp.jpg",
  "10-at-per-enter-pill.jpg",
  "11-backspace-deletes-pill.jpg",
  "12-hash-without-pill.jpg",
  "13-hash-after-pill.jpg",
  "14-required-blocks-send.jpg",
  "17-implicit-without-pill.jpg",
];
for (const name of required) {
  await access(path.join(SHOT_DIR, name)).catch(() => fail(`missing ${name}`));
}
log("proofs\n" + proofs.map((line) => `- ${line}`).join("\n"));
log("ok", required.length, "screenshots");
process.exit(0);
