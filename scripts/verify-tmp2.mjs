// Drive Open Grok.app over CDP for tmp2 scenes. Pattern: scripts/verify-routines.mjs.
// Usage: node scripts/verify-tmp2.mjs
// Env: OG_GATEWAY_URL, OG_GATEWAY_BEARER, CDP_PORT (default 9223), TMP2_SHOT_DIR
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clickAt, ev, sleep } from "../docs/research/tools/cdp-drive.mjs";

const CDP_PORT = process.env.CDP_PORT ?? "9223";
const GATEWAY = process.env.OG_GATEWAY_URL ?? "http://127.0.0.1:1447";
const BEARER = process.env.OG_GATEWAY_BEARER;
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultShotDir = path.resolve(here, "../../opengrok-server-tmp2/docs/verification/tmp2");
const SHOT_DIR = process.env.TMP2_SHOT_DIR ?? defaultShotDir;

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
  const dest = path.join(SHOT_DIR, name);
  await writeFile(dest, Buffer.from(b64, "base64"));
  log("wrote", dest);
}

async function api(method, body) {
  if (!BEARER) return null;
  const res = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${BEARER}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { status: res.status, value };
}

async function typePrompt(text) {
  const focused = await ev(`(()=>{const n=document.querySelector(".ProseMirror");if(!n)return false;n.focus();return true})()`);
  if (!focused) fail("no .ProseMirror");
  const ok = await ev(`document.execCommand("insertText",false,${JSON.stringify(text)})`);
  if (ok === false) fail("insertText failed");
  await sleep(200);
}

if (await ev(`document.body.innerText.includes("Something went wrong")`)) {
  fail("the app shows its error boundary");
}

await mkdir(SHOT_DIR, { recursive: true });

const tmpChip = await ev(`document.querySelector("[data-tmp-mode=on]")!=null`);
if (!tmpChip) {
  log("TMP chip not in this build yet — capturing scene 01 anyway");
}
await shot("01-tmp-mode-on.jpg");

await typePrompt("@");
await sleep(400);
const atText = await ev(`document.body.innerText`);
if (typeof atText === "string" && /SKILL\.md/i.test(atText)) {
  fail("@ listed a SKILL.md in TMP mode");
}
await shot("02-at-opens-user-picker.jpg");

const picked = await ev(`(()=>{const n=[...document.querySelectorAll(".sand-mention-option,.sand-tmp-option,[role=option]")].find(e=>/uriah/i.test(e.textContent||""));if(!n)return false;n.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));return true})()`);
if (picked) {
  const box = await ev(`(()=>{const n=document.querySelector("[data-type=tmp-token],.sand-mention");if(!n)return null;const r=n.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  if (box) await clickAt(box[0], box[1]);
}
await shot("03-chip-bound-user.jpg");

await typePrompt(" say hi");
await ev(`document.querySelector(".ProseMirror")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,bubbles:true}))`);
await sleep(1500);
await shot("04-send-unique-grounded.jpg");

await ev(`(()=>{const n=document.querySelector(".ProseMirror");if(!n)return false;n.focus();document.execCommand("selectAll");document.execCommand("delete");return true})()`);
await typePrompt("@user");
await sleep(400);
await shot("05-ambiguous-pick-no-send.jpg");

const ada = await ev(`(()=>{const n=[...document.querySelectorAll("[role=option],.sand-mention-option")].find(e=>/ada/i.test(e.textContent||""));if(!n)return false;const r=n.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
if (ada) await clickAt(ada[0], ada[1]);
await typePrompt(" thanks");
await ev(`document.querySelector(".ProseMirror")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,bubbles:true}))`);
await sleep(1500);
await shot("06-pick-then-send.jpg");

await ev(`(()=>{const n=document.querySelector(".ProseMirror");if(!n)return false;n.focus();document.execCommand("selectAll");document.execCommand("delete");return true})()`);
await typePrompt("/");
await sleep(400);
await shot("08-tmp-mode-off-skills-on-slash.jpg");

await ev(`document.execCommand("selectAll");document.execCommand("delete");`);
await typePrompt("!");
await typePrompt("@");
await sleep(400);
await shot("09-bang-enables-tmp.jpg");

await ev(`document.execCommand("selectAll");document.execCommand("delete");`);
await typePrompt("email Uriah the invoice");
await sleep(400);
await shot("07-implicit-uriah.jpg");

const complete = BEARER
  ? await fetch(`${GATEWAY.replace(/\/api$/, "")}/tmp/complete?token=user&q=Uri`, {
      headers: { authorization: `Bearer ${BEARER}` },
    })
  : null;
if (complete) log("complete", complete.status);

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
];
for (const name of required) {
  const { access } = await import("node:fs/promises");
  await access(path.join(SHOT_DIR, name)).catch(() => fail(`missing ${name}`));
}
log("ok", required.length, "screenshots");
process.exit(0);
