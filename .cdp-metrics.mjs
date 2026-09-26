// Set the viewport, dispatch resize (Electron fires none for metrics overrides),
// then evaluate CDP_EXPR at each width.
import { WebSocket } from "ws";
const port = process.env.CDP_PORT ?? "9225";
const widths = process.argv.slice(2).map(Number);
const list = await (await fetch(`http://localhost:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once("open", r));
let id = 0; const pending = new Map();
ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } });
const send = (method, params) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value ?? res.result?.exceptionDetails?.text ?? null;
};
const expression = process.env.CDP_EXPR ?? `(()=>({w:innerWidth}))()`;
const out = [];
for (const width of widths) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 980, deviceScaleFactor: 0, mobile: false });
  await evaluate(`(async()=>{window.dispatchEvent(new Event("resize"));await new Promise(r=>setTimeout(r,600));return 1})()`);
  out.push(await evaluate(expression));
}
await send("Emulation.clearDeviceMetricsOverride", {});
console.log(JSON.stringify(out));
ws.close();
