import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { simple as walkSimple } from "acorn-walk";

// KaTeX (MathML output) + its auto-render contrib, inlined into index.html at
// build time. Vendored rather than added to the pinned renderer asset tree, so
// the checksum-pinned 0.18 bundle stays byte-for-byte pristine.
const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "vendor");
const KATEX_JS = readFileSync(path.join(VENDOR_DIR, "katex.min.js"), "utf8");
const REMARK_MATH_JS = readFileSync(path.join(VENDOR_DIR, "remark-math.min.js"), "utf8");
const MATH_KIT_JS = readFileSync(path.join(VENDOR_DIR, "sand-math-kit.js"), "utf8");

const REGISTRY_BEFORE = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const REGISTRY_AFTER = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"router",label:"Computer",icon:"device-desktop"},{id:"dictation",label:"Dictation",icon:"mic"},{id:"usage",label:"Usage",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
// The stock registry hides the usage tab unless a Cursor account is signed in;
// routed providers track usage locally, so the tab must always be visible.
const USAGE_TAB_FILTER_BEFORE = 'i=wDn.filter(o=>o.id!=="usage"||r)';
const USAGE_TAB_FILTER_AFTER = 'i=wDn';
const GENERAL_BEFORE = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null';
const GENERAL_AFTER = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):x==="router"?a.jsx(RRouterPanel,{}):x==="dictation"?a.jsx(RDictationPanel,{}):null';
const USAGE_BEFORE = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null';
const USAGE_AFTER = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(RRouterUsage,{})}):null';
const COMPONENT_ANCHOR = 'function Sa(s){';
export const CURSOR_LOGIN_WALL_SKIP_KEY = "sand-cursor-login-skip";
export const OPENGROK_MODE_KEY = "sand-opengrok-mode";

/**
 * May the login wall be bypassed?
 *
 * The skip exists because the app could run with no backend at all - that is
 * what lets Codex and OpenRouter work without a Cursor account. An OpenGrok
 * server IS a backend, with real accounts, so bypassing it there would drop a
 * signed-out person straight into someone's dashboard. In that mode the wall
 * stands and you sign in for real.
 */
const MAY_SKIP_LOGIN_WALL = `(()=>{try{return localStorage.getItem("${CURSOR_LOGIN_WALL_SKIP_KEY}")==="1"&&localStorage.getItem("${OPENGROK_MODE_KEY}")!=="1"}catch{return!1}})()`;
const LOGIN_WALL_REPLACEMENTS = [
  [
    'if(s!==!0)return{kind:"landed",gate:r?"sign-in":"onboarding",sessionFact:s,provisional:!1}',
    `if(s!==!0){try{if(${MAY_SKIP_LOGIN_WALL})return{kind:"landed",gate:"shell",sessionFact:!0,provisional:!1}}catch{}return{kind:"landed",gate:r?"sign-in":"onboarding",sessionFact:s,provisional:!1}}`,
    "login-wall gate",
  ],
  [
    'case"skip-onboarding":return e.isSignedIn?{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:!1}:n;',
    'case"skip-onboarding":return{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:!1};',
    "skip-onboarding checking",
  ],
  [
    'case"skip-onboarding":return e.isSignedIn||n.signedIn?{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:!1}:n.forced?{...n,forced:!1}:n;',
    'case"skip-onboarding":return{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:!1};',
    "skip-onboarding onboarding",
  ],
  [
    'case"signed-out":return Uoe(n,{forced:!1,signedIn:!1,owedShell:{slot:e.accountSlot,provisional:n.provisional}});',
    `case"signed-out":try{if(${MAY_SKIP_LOGIN_WALL})return n}catch{}return Uoe(n,{forced:!1,signedIn:!1,owedShell:{slot:e.accountSlot,provisional:n.provisional}});`,
    "shell signed-out",
  ],
  [
    'u({kind:"skip-onboarding",isSignedIn:f})',
    'u({kind:"skip-onboarding",isSignedIn:!0})',
    "skip-onboarding emit",
  ],
  [
    'Ae=Ne.status.kind==="logged-in"',
    `Ae=Ne.status.kind==="logged-in"||(()=>{try{return ${MAY_SKIP_LOGIN_WALL}}catch{return!1}})()`,
    "composer signed-in",
  ],
  [
    // 0.18 only z.connect()/listAgents when resolveAccountSlot returns a slot.
    // Cursor logged-out yields slot:null, so the sidebar stays empty until
    // createAgent posts a complete-roster event. Same local slot as main.
    'function Wzn(n){try{const e=await n();return e.kind==="logged-in"&&dde(e)==null?{kind:"unavailable"}:{kind:"resolved",slot:dde(e)}}catch(e){return yBn(e),{kind:"unavailable"}}}',
    `function Wzn(n){try{const e=await n();if(e.kind==="logged-in"){const t=dde(e);return t==null?{kind:"unavailable"}:{kind:"resolved",slot:t}}try{if(${MAY_SKIP_LOGIN_WALL})return{kind:"resolved",slot:"local-subscription"}}catch{}return{kind:"resolved",slot:null}}catch(e){return yBn(e),{kind:"unavailable"}}}`,
    "account slot for skipped login",
  ],
];

export const COMPONENT_SOURCE = String.raw`
const RRouterProviders=[
  {value:"cursor",label:"Cursor",description:"Use your signed-in Cursor account.",kind:"account"},
  {value:"claude-code",label:"Claude Code",description:"Use your Claude Pro/Max subscription via the official Claude login.",kind:"local",localKey:"claude-code"},
  {value:"codex",label:"Codex",description:"Use your ChatGPT subscription via the official Codex login.",kind:"local",localKey:"codex"},
  {value:"openrouter",label:"OpenRouter",description:"Route through your OpenRouter account and selected model.",kind:"key",secret:"OPENROUTER_API_KEY"}
],RRouterOptions=RRouterProviders.map(s=>({value:s.value,label:s.label})),RRouterEmptyUsage={requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,lastUsedAt:null},RRouterInputClass="sand-9f619 sand-h8yej3 sand-5f5z56 sand-u97haq sand-lrnmfh sand-uve7l6 sand-16b7oty sand-1rgtt3y sand-o7x2bt sand-mkeg23 sand-1y0btm7 sand-qz0629 sand-1043rbw sand-13l7odt sand-1wd3ewq sand-jb2p0i sand-4z9k3i sand-frs9s4 sand-tt52l0 sand-1odjw0f sand-1t137rt sand-ltfok3";
function RQuoteProvider(n){return n==="cursor"?"cursor":n==="claude-code"?"claude-code":n==="openrouter"?"openrouter":"codex"}
let RRouterLast=null;
function RRouterState(){
  // Seeded from the last answer, not from a guess. Starting at "cursor" made the
  // panel state a default as though it were the saved choice, so every reopen
  // showed Cursor and Grok VM until the load returned - which read as the
  // setting reverting. The loaded flag keeps the controls quiet until it lands.
  const RRouterSeed=()=>{try{const raw=localStorage.getItem("sandRouterSeed.v1");if(!raw)return null;const d=JSON.parse(raw);if(!d||typeof d.provider!=="string")return null;return{provider:d.provider,usage:null,local:null,computers:null,openRouterModel:typeof d.openRouterModel==="string"?d.openRouterModel:null,error:null,loaded:!1}}catch{return null}};const[s,e]=de.useState(()=>RRouterLast??RRouterSeed()??{provider:null,usage:null,local:null,computers:null,openRouterModel:null,error:null,loaded:!1});
  de.useEffect(()=>{let t=!0;const apply=r=>{if(!t||r==null)return;e(i=>{const next={...i,...r,error:null,loaded:!0};RRouterLast=next;try{if(typeof next.provider==="string")localStorage.setItem("sandRouterSeed.v1",JSON.stringify({provider:next.provider,openRouterModel:next.openRouterModel??null}))}catch{}return next})};const n=r=>apply(r.detail);window.addEventListener("sand-router-provider-changed",n);const load=()=>window.desktop.agent.getInferenceRouter().then(apply).catch(r=>{t&&e(i=>({...i,error:String(r?.message??r)}))});load();
  // Each refresh shells out to the provider CLIs; polling this every 2s spawned
  // those subprocesses continuously for as long as Settings stayed open.
  const id=setInterval(load,15e3);return()=>{t=!1;clearInterval(id);window.removeEventListener("sand-router-provider-changed",n)}},[]);
  const t=async n=>{const r=s;e(i=>({...i,provider:n,error:null}));try{const i=await window.desktop.agent.setInferenceRouter(n),o={...i,provider:RQuoteProvider(i.provider??n),error:null};e(o);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:o}))}catch(i){e({...r,error:String(i?.message??i)})}};
  const g=async n=>{try{await window.desktop.agent.startSubscriptionLogin(n);const i=await window.desktop.agent.getInferenceRouter(),o={...i,provider:RQuoteProvider(i.provider??n),error:null};e(o);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:o}))}catch(i){e(r=>({...r,error:String(i?.message??i)}))}};
  return[s,t,g,e]
}
function RRouterSecrets(){const[s,e]=de.useState([]),[t,n]=de.useState(0);de.useEffect(()=>{let r=!0;window.desktop.secrets.list().then(i=>{r&&e(Array.isArray(i?.keys)?i.keys:[])});return()=>{r=!1}},[t]);return[s,()=>n(r=>r+1)]}
function RRouterNumber(s){return new Intl.NumberFormat().format(s)}
function ROpenRouterModel({model:s,onSaved:e}){const[r,i]=de.useState(typeof s==="string"?s:""),[o,l]=de.useState(!1),[p,q]=de.useState(null);de.useEffect(()=>{if(typeof s==="string")i(s)},[s]);const d=async()=>{const v=r.trim();if(v.length===0){q("Enter a model id, for example openai/gpt-4o-mini or org/model:free.");return}l(!0);q(null);try{const n=await window.desktop.agent.setOpenRouterModel(v);i(n.openRouterModel??n.model??v);e&&e(n)}catch(u){q(String(u&&u.message||u))}finally{l(!1)}};return a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{width:360,flexWrap:"wrap",gap:8},children:[a.jsx("input",{"aria-label":"OpenRouter model",className:RRouterInputClass,disabled:o,onChange:u=>i(u.currentTarget.value),placeholder:"openai/gpt-4o-mini or org/model:free",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},value:r}),a.jsx(oe,{disabled:o,onClick:d,shape:"rectangular",size:"sm",variant:"secondary",children:o?"Saving…":"Save"}),p?a.jsx(se,{as:"span",color:"red",size:"sm",children:p}):null]})}
function RRouterCredential({provider:s,state:e,keys:t,onSaved:n,onLogin:g}){const[r,i]=de.useState(""),[o,l]=de.useState(!1),[p,q]=de.useState(null),f=de.useRef(null);if(s.kind==="account")return a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Signed in"});if(s.kind==="local"){const c=e.local?.[s.localKey],d=c?.installed&&c?.authenticated,h=d?"Signed in":c?.installed?"Sign in with "+(s.value==="codex"?"codex login":"claude /login"):"Not installed";const showAction=!d&&(c?.installed||s.value==="codex");return a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{flexWrap:"wrap",gap:8,maxWidth:420,minWidth:0},children:[a.jsx(se,{as:"span",color:d?"primary":"secondary",size:"sm",style:{flex:"1 1 220px",minWidth:0},children:c?.prompt??h}),showAction?a.jsx(oe,{onClick:()=>{if(g)void g(s.value)},shape:"rectangular",size:"sm",variant:"secondary",children:c?.installed?"Sign in":"Install Codex CLI"}):null]})}const c=t.includes(s.secret),d=async()=>{const v=((f.current&&f.current.value)||r).trim();if(v.length===0){q("Paste an API key first.");return}l(!0);q(null);try{await window.desktop.secrets.upsert({[s.secret]:v}),i(""),f.current&&(f.current.value=""),n()}catch(u){q(String(u&&u.message||u))}finally{l(!1)}};return a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{width:360,flexWrap:"wrap",gap:8},children:[a.jsx("input",{"aria-label":s.secret,className:RRouterInputClass,disabled:o,onChange:u=>i(u.currentTarget.value),onInput:u=>i(u.currentTarget.value),placeholder:c?"Replace saved key":"Paste API key",ref:f,style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"password",value:r}),a.jsx(oe,{disabled:o,onClick:d,shape:"rectangular",size:"sm",variant:"secondary",children:o?"Saving…":"Save"}),p?a.jsx(se,{as:"span",color:"red",size:"sm",children:p}):null]})}
const RLangOptions=[
  {code:"en-US",label:"English (US)"},{code:"en-GB",label:"English (UK)"},{code:"en-IN",label:"English (India)"},
  {code:"fil-PH",label:"Filipino (Tagalog)"},{code:"ceb",label:"Cebuano"},
  {code:"af-ZA",label:"Afrikaans"},{code:"am-ET",label:"Amharic"},{code:"ar-EG",label:"Arabic (Egypt)"},{code:"hy-AM",label:"Armenian"},{code:"as-IN",label:"Assamese"},{code:"az-AZ",label:"Azerbaijani"},{code:"be-BY",label:"Belarusian"},{code:"bn-BD",label:"Bengali (Bangladesh)"},{code:"bn-IN",label:"Bengali (India)"},{code:"bs-BA",label:"Bosnian"},{code:"bg-BG",label:"Bulgarian"},{code:"my-MM",label:"Burmese"},{code:"yue-Hant-HK",label:"Cantonese (Traditional)"},{code:"ca-ES",label:"Catalan"},{code:"km-KH",label:"Central Khmer"},{code:"hr-HR",label:"Croatian"},{code:"cs-CZ",label:"Czech"},{code:"da-DK",label:"Danish"},{code:"nl-NL",label:"Dutch"},{code:"et-EE",label:"Estonian"},{code:"fa-IR",label:"Farsi"},{code:"fi-FI",label:"Finnish"},{code:"fr-FR",label:"French"},{code:"gl-ES",label:"Galician"},{code:"ka-GE",label:"Georgian"},{code:"de-DE",label:"German"},{code:"el-GR",label:"Greek"},{code:"gu-IN",label:"Gujarati"},{code:"ha-NG",label:"Hausa"},{code:"he-IL",label:"Hebrew"},{code:"hi-IN",label:"Hindi"},{code:"hu-HU",label:"Hungarian"},{code:"is-IS",label:"Icelandic"},{code:"id-ID",label:"Indonesian"},{code:"it-IT",label:"Italian"},{code:"ja-JP",label:"Japanese"},{code:"jv-ID",label:"Javanese"},{code:"kea-CV",label:"Kabuverdianu"},{code:"kn-IN",label:"Kannada"},{code:"kk-KZ",label:"Kazakh"},{code:"ko-KR",label:"Korean"},{code:"ky-KG",label:"Kyrgyz"},{code:"lv-LV",label:"Latvian"},{code:"ln-CD",label:"Lingala"},{code:"lt-LT",label:"Lithuanian"},{code:"mk-MK",label:"Macedonian"},{code:"ms-MY",label:"Malay"},{code:"ml-IN",label:"Malayalam"},{code:"mt-MT",label:"Maltese"},{code:"cmn-Hans-CN",label:"Mandarin Chinese (Simplified)"},{code:"mr-IN",label:"Marathi"},{code:"mn-MN",label:"Mongolian"},{code:"ne-NP",label:"Nepali"},{code:"nb-NO",label:"Norwegian"},{code:"or-IN",label:"Oriya"},{code:"pl-PL",label:"Polish"},{code:"pt-BR",label:"Portuguese (Brazil)"},{code:"pt-PT",label:"Portuguese (Portugal)"},{code:"pa-IN",label:"Punjabi"},{code:"ro-RO",label:"Romanian"},{code:"ru-RU",label:"Russian"},{code:"sr-RS",label:"Serbian"},{code:"sk-SK",label:"Slovak"},{code:"sl-SI",label:"Slovenian"},{code:"es-419",label:"Spanish (Latin America)"},{code:"es-US",label:"Spanish (US)"},{code:"sw-KE",label:"Swahili (Kenya)"},{code:"sv-SE",label:"Swedish"},{code:"tg-TJ",label:"Tajik"},{code:"te-IN",label:"Telugu"},{code:"th-TH",label:"Thai"},{code:"tr-TR",label:"Turkish"},{code:"uk-UA",label:"Ukrainian"},{code:"uz-UZ",label:"Uzbek"},{code:"vi-VN",label:"Vietnamese"}
];
function RTranscribe({keys:s,onSaved:e}){
  const[t,n]=de.useState({geminiEnabled:!1,geminiKeySet:!1,languages:["en-US"]});
  const[r,i]=de.useState(""),[o,l]=de.useState(!1),[p,q]=de.useState(null);
  const[langQuery,setLangQuery]=de.useState(""),[langOpen,setLangOpen]=de.useState(!1),[langBusy,setLangBusy]=de.useState(!1);
  de.useEffect(()=>{let c=!0;const load=()=>window.desktop.getTranscribeSettings().then(d=>{if(c&&d)n(h=>({...h,...d}))}).catch(()=>{});load();const id=setInterval(load,5e3);return()=>{c=!1;clearInterval(id)}},[]);
  const g=async c=>{n(d=>({...d,geminiEnabled:c}));try{const d=await window.desktop.setTranscribeSettings({geminiEnabled:c});n(h=>({...h,...d}))}catch(d){q(String(d&&d.message||d))}};
  const att=t.lastAttempt;
  const attTime=att&&typeof att.at==="string"?new Date(att.at).toLocaleTimeString():null;
  const attStatus=att==null?null:att.geminiStatus==="quota"?{color:"red",text:"Gemini free-tier quota hit — the last dictation fell back to "+(att.engine||"another engine")+". Quota resets around midnight PT, or add billing to the key."}:att.geminiStatus==="bad-key"?{color:"red",text:"Gemini rejected the API key — paste a valid AI Studio key above."}:att.geminiStatus==="no-key"?{color:"secondary",text:"No Gemini key was available for the last dictation — it used "+(att.engine||"a fallback")+"."}:att.geminiStatus==="error"?{color:"red",text:"Gemini failed on the last dictation ("+String(att.geminiError||"unknown").slice(0,80)+") — it used "+(att.engine||"a fallback")+"."}:att.engine==="gemini"?{color:"secondary",text:"Last dictation used Gemini"+(attTime?" at "+attTime:"")+". Working normally."}:{color:"secondary",text:"Last dictation used "+(att.engine||"another engine")+(attTime?" at "+attTime:"")+"."};
  const langs=Array.isArray(t.languages)?t.languages:[];
  const saveLangs=async c=>{setLangBusy(!0);q(null);try{const d=await window.desktop.setTranscribeSettings({languages:c});n(h=>({...h,...d}))}catch(d){q(String(d&&d.message||d))}finally{setLangBusy(!1)}};
  const addLang=c=>{if(langs.includes(c)||langs.length>=5)return;setLangQuery("");void saveLangs([...langs,c])};
  const removeLang=c=>{void saveLangs(langs.filter(d=>d!==c))};
  const ql=langQuery.trim().toLowerCase();
  const langMatches=RLangOptions.filter(c=>!langs.includes(c.code)&&(ql.length===0||c.label.toLowerCase().includes(ql)||c.code.toLowerCase().includes(ql)));
  const customLang=/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(langQuery.trim())&&!langs.includes(langQuery.trim())&&!RLangOptions.some(c=>c.code.toLowerCase()===ql);
  const u=s.includes("GEMINI_API_KEY")||t.geminiKeySet;
  const f=async()=>{const c=r.trim();if(c.length===0){q("Paste your Google AI Studio API key first.");return}l(!0);q(null);try{await window.desktop.secrets.upsert({GEMINI_API_KEY:c});i("");if(e)e();const d=await window.desktop.getTranscribeSettings().catch(()=>null);if(d)n(h=>({...h,...d}))}catch(c){q(String(c&&c.message||c))}finally{l(!1)}};
  return a.jsxs("div",{children:[
    a.jsx(ie,{description:"Dictation through Google's gemini-3.5-transcribe with your own AI Studio key (the free tier works). When off, dictation uses the Cursor account or a local whisper-cpp install.",label:"Gemini transcription",variant:"card",children:a.jsx(ye,{"aria-label":"Gemini transcription",onValueChange:c=>{if(c!=null)void g(c==="on")},options:[{value:"off",label:"Off"},{value:"on",label:"On"}],placement:"bottom-end",size:"lg",value:t.geminiEnabled?"on":"off",variant:"filled"})}),
    t.geminiEnabled?a.jsx(ie,{divided:!0,description:u?"A key is saved. Paste a new one to replace it.":"From aistudio.google.com → Get API key.",label:"Google API key",variant:"card",children:a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{width:360,flexWrap:"wrap",gap:8},children:[a.jsx("input",{"aria-label":"GEMINI_API_KEY",className:RRouterInputClass,disabled:o,onChange:c=>i(c.currentTarget.value),onInput:c=>i(c.currentTarget.value),placeholder:u?"Replace saved key":"Paste Google AI Studio key",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"password",value:r}),a.jsx(oe,{disabled:o,onClick:f,shape:"rectangular",size:"sm",variant:"secondary",children:o?"Saving…":"Save"}),p?a.jsx(se,{as:"span",color:"red",size:"sm",children:p}):null]})}):null,
    t.geminiEnabled?a.jsx(ie,{divided:!0,description:"English is always understood — add the other language(s) you speak (like Filipino) and mixed speech keeps both.",label:"Languages",variant:"card",children:a.jsxs("div",{style:{position:"relative",width:360,maxWidth:"100%"},children:[
      a.jsxs("div",{style:{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center",minHeight:38,padding:"5px 8px",boxSizing:"border-box",background:"var(--cursor-bg-secondary,#292929)",border:"1px solid var(--cursor-stroke-tertiary,#3a3a3a)",borderRadius:8},children:[
        ...langs.map(c=>{const d=RLangOptions.find(h=>h.code===c);return a.jsxs("span",{style:{display:"inline-flex",alignItems:"center",gap:5,padding:"2px 9px",fontSize:12,lineHeight:"18px",borderRadius:999,background:"var(--cursor-bg-tertiary,#3a3a3a)",color:"var(--cursor-text-primary,#ececec)",whiteSpace:"nowrap"},children:[d?d.label:c,a.jsx("button",{"aria-label":"Remove "+c,disabled:langBusy,onClick:()=>removeLang(c),style:{all:"unset",cursor:"pointer",fontSize:13,lineHeight:"14px",opacity:.65},type:"button",children:"×"})]},c)}),
        a.jsx("input",{"aria-label":"Filter languages",disabled:langBusy,onChange:c=>{setLangQuery(c.currentTarget.value);setLangOpen(!0)},onInput:c=>{setLangQuery(c.currentTarget.value);setLangOpen(!0)},onFocus:()=>setLangOpen(!0),onBlur:()=>setTimeout(()=>setLangOpen(!1),150),onKeyDown:c=>{if(c.key==="Enter"&&customLang)addLang(langQuery.trim());if(c.key==="Escape")setLangOpen(!1);if(c.key==="Backspace"&&langQuery.length===0&&langs.length>0)removeLang(langs[langs.length-1])},placeholder:langs.length===0?"Search languages…":"Add…",style:{flex:"1 0 80px",minWidth:56,fontSize:13,background:"transparent",border:"none",outline:"none",color:"var(--cursor-text-primary,#ececec)"},value:langQuery})
      ]}),
      langOpen&&(langMatches.length>0||customLang)?a.jsxs("div",{style:{marginTop:6,maxHeight:180,overflowY:"auto",background:"var(--cursor-bg-secondary,#292929)",border:"1px solid var(--cursor-stroke-tertiary,#3a3a3a)",borderRadius:8},children:[
        ...langMatches.slice(0,12).map(c=>a.jsxs("button",{onMouseDown:d=>{d.preventDefault();addLang(c.code)},style:{display:"flex",width:"100%",justifyContent:"space-between",alignItems:"center",gap:8,padding:"7px 10px",fontSize:13,background:"transparent",border:"none",cursor:"pointer",color:"var(--cursor-text-primary,#ececec)",textAlign:"left",boxSizing:"border-box"},type:"button",children:[a.jsx("span",{children:c.label}),a.jsx("span",{style:{opacity:.55,fontSize:12},children:c.code})]},c.code)),
        customLang?a.jsx("button",{onMouseDown:d=>{d.preventDefault();addLang(langQuery.trim())},style:{display:"block",width:"100%",padding:"7px 10px",fontSize:13,background:"transparent",border:"none",cursor:"pointer",color:"var(--cursor-text-primary,#ececec)",textAlign:"left",boxSizing:"border-box"},type:"button",children:'Add "'+langQuery.trim()+'"'}):null
      ]}):null
    ]})}):null,
    t.geminiEnabled&&attStatus?a.jsx(ie,{divided:!0,label:"Status",variant:"card",children:a.jsx(se,{as:"span",color:attStatus.color,size:"sm",style:{maxWidth:360},children:attStatus.text})}):null
  ]})
}
function RRouterUsageRows({usage:s}){return a.jsxs("div",{children:[a.jsx(ie,{label:"Requests",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.requests)})}),a.jsx(ie,{divided:!0,label:"Input tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.inputTokens)})}),a.jsx(ie,{divided:!0,label:"Output tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.outputTokens)})}),a.jsx(ie,{divided:!0,label:"Cache tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.cacheReadTokens+s.cacheWriteTokens)})}),a.jsx(ie,{divided:!0,label:"Last used",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:s.lastUsedAt?new Date(s.lastUsedAt).toLocaleString():"Not used yet"})})]})}
function RW365Field(s){return a.jsxs("label",{style:{display:"block",marginTop:12,maxWidth:420},children:[a.jsx("span",{style:{display:"block",fontSize:12,fontWeight:600,lineHeight:"16px",color:"var(--cursor-text-primary,#ececec)"},children:s.label}),s.hint?a.jsx("span",{style:{display:"block",marginTop:2,fontSize:11,lineHeight:"14px",color:"var(--cursor-text-secondary,#aaa)"},children:s.hint}):null,a.jsx("input",{"aria-label":s.label,autoComplete:"off",onChange:e=>s.onChange(e.currentTarget.value),placeholder:s.placeholder||"",spellCheck:!1,style:{boxSizing:"border-box",display:"block",width:"100%",maxWidth:420,height:36,marginTop:6,padding:"8px 12px",fontSize:13,lineHeight:"20px",color:"var(--cursor-text-primary,#ececec)",background:"var(--cursor-bg-secondary,#292929)",border:"1px solid var(--cursor-stroke-tertiary,#3a3a3a)",borderRadius:8,outline:"none"},type:s.type||"text",value:s.value})]})}
function RW365Setup(){const[s,e]=de.useState({sessionBaseUrl:"https://windows365.microsoft.com",poolId:"",tenantId:"",clientId:"",userObjectId:"",tokenScope:"api://W365Agents-Prod/.default",hasClientSecret:!1,configured:!1,secret:"",session:null,busy:!1,notice:null,error:null});de.useEffect(()=>{let t=!0;Promise.all([window.desktop.agent.getWindows365Settings(),window.desktop.agent.getWindows365Session()]).then(n=>{if(!t)return;e(r=>({...r,...n[0],session:n[1],error:null}))}).catch(n=>{t&&e(r=>({...r,error:String(n?.message??n)}))});return()=>{t=!1}},[]);const t=async n=>{e(r=>({...r,busy:!0,error:null,notice:null}));try{await n()}catch(n){e(r=>({...r,error:String(n?.message??n)}))}finally{e(r=>({...r,busy:!1}))}};const n=async()=>{const r=await window.desktop.agent.setWindows365Settings({sessionBaseUrl:s.sessionBaseUrl,poolId:s.poolId,tenantId:s.tenantId,clientId:s.clientId,userObjectId:s.userObjectId,tokenScope:s.tokenScope,reuseSession:!0,...(s.secret.length>0?{clientSecret:s.secret}:{})});e(i=>({...i,...r,secret:""}));return r};return a.jsxs("div",{style:{marginTop:12,padding:"4px 2px 8px",maxWidth:440},children:[a.jsx(se,{as:"p",color:"secondary",size:"sm",children:"Windows 365 for Agents needs an Entra app registration and an Intune pool. Values stay on this Mac. One Cloud PC is reused until you check it in."}),a.jsx(RW365Field,{label:"Tenant ID",value:s.tenantId,onChange:r=>e(i=>({...i,tenantId:r}))}),a.jsx(RW365Field,{label:"Application (client) ID",value:s.clientId,onChange:r=>e(i=>({...i,clientId:r}))}),a.jsx(RW365Field,{label:"Client secret",type:"password",hint:s.hasClientSecret?"A secret is already saved. Leave blank to keep it.":"From the Entra app registration.",placeholder:s.hasClientSecret?"••••••••":"",value:s.secret,onChange:r=>e(i=>({...i,secret:r}))}),a.jsx(RW365Field,{label:"Pool ID",hint:"Intune Windows 365 for Agents pool",value:s.poolId,onChange:r=>e(i=>({...i,poolId:r}))}),a.jsx(RW365Field,{label:"Entra user object ID",hint:"The user allowed to check out the Cloud PC",value:s.userObjectId,onChange:r=>e(i=>({...i,userObjectId:r}))}),a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4",style:{flexWrap:"wrap",gap:8,marginTop:12},children:[a.jsx(oe,{disabled:s.busy,onClick:()=>t(async()=>{const r=await n();e(i=>({...i,notice:r.configured?"Credentials saved. Click Connect to check out the Cloud PC.":"Saved. Fill tenant, client, secret, pool, and user id."}))}),shape:"rectangular",size:"sm",variant:"primary",children:s.busy?"Working…":"Save"}),a.jsx(oe,{disabled:s.busy,onClick:()=>t(async()=>{await n();const r=await window.desktop.agent.testWindows365();e(i=>({...i,notice:r.ok?r.detail:null,error:r.ok?null:r.detail}))}),shape:"rectangular",size:"sm",variant:"secondary",children:"Test sign-in"}),a.jsx(oe,{disabled:s.busy,onClick:()=>t(async()=>{await n();const r=await window.desktop.agent.checkoutWindows365();e(i=>({...i,session:r,configured:!0,notice:r.detail}));const o=r.seeUrl||r.screenshareUrl;if(o)await window.desktop.openExternal(o)}),shape:"rectangular",size:"sm",variant:"secondary",children:"Connect"}),a.jsx(oe,{disabled:s.busy||!(s.session&&s.session.computerId),onClick:()=>t(async()=>{const r=await window.desktop.agent.checkinWindows365();e(i=>({...i,session:r,notice:r.detail}))}),shape:"rectangular",size:"sm",variant:"secondary",children:"Check in"})]}),s.notice?a.jsx(se,{as:"p",size:"sm",children:s.notice}):null,s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null,s.session&&s.session.detail?a.jsx(se,{as:"p",color:"secondary",size:"sm",children:s.session.detail}):null]})}
let RBoxLast=null;
function ROpenGrokSeeded(){if(RBoxLast&&typeof RBoxLast.mode==="string")return RBoxLast.mode==="opengrok";try{return localStorage.getItem("sand-opengrok-mode")==="1"}catch(_){return!1}}
function ROpenGrokActive(){const[v,setV]=de.useState(()=>ROpenGrokSeeded());
de.useEffect(()=>{let alive=!0;const read=()=>window.desktop.agent.getBoxRuntime().then(r=>{if(alive&&r!=null)setV(r.mode==="opengrok")}).catch(()=>{});
read();const onChange=()=>read();window.addEventListener("sand-box-runtime-changed",onChange);window.addEventListener("sand-opengrok-changed",onChange);
const id=setInterval(read,15e3);return()=>{alive=!1;clearInterval(id);window.removeEventListener("sand-box-runtime-changed",onChange);window.removeEventListener("sand-opengrok-changed",onChange)}},[]);
return v}

function ROpenGrokServer(){const[s,e]=de.useState({url:"",saved:null,status:null,busy:!1,error:null,dirty:!1});
const load=()=>window.desktop.agent.getOpenGrokServer().then(r=>{if(r==null)return;e(i=>({...i,saved:r.gatewayUrl??null,url:i.dirty||i.busy?i.url:(r.gatewayUrl??""),status:r.status??null}))}).catch(()=>{});
de.useEffect(()=>{load();const id=setInterval(load,15e3);return()=>clearInterval(id)},[]);
const save=async()=>{e(i=>({...i,busy:!0,error:null}));try{const r=await window.desktop.agent.setOpenGrokServer(s.url.trim());e(i=>({...i,busy:!1,dirty:!1,saved:r.gatewayUrl??null,status:r.status??null}));window.dispatchEvent(new CustomEvent("sand-opengrok-changed",{detail:{gatewayUrl:r.gatewayUrl??null}}))}catch(err){e(i=>({...i,busy:!1,error:String(err&&err.message||err)}))}};
const st=s.status,connected=!!(st&&st.ok);
const changed=s.dirty&&s.url.trim()!==(s.saved??"");
const detail=s.saved==null?"Add your server address, then sign in from General.":connected?(st&&st.detail)||"Connected.":"Saved. Sign in from General to use it.";
return a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-dt5ytf",style:{gap:10},children:[
a.jsx(ie,{description:"Where your OpenGrok server is reachable, including the scheme and port. Your account lives on that server, so signing in happens under General.",label:"Server URL",variant:"card",children:a.jsx("input",{"aria-label":"OpenGrok server URL",className:RRouterInputClass,disabled:s.busy,onChange:v=>e(i=>({...i,url:v.currentTarget.value,dirty:!0})),placeholder:"http://192.168.1.10:1447",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:300},type:"text",value:s.url})}),
a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{gap:8,flexWrap:"wrap",paddingBottom:4,marginTop:2},children:[
a.jsx(oe,{disabled:!changed||s.url.trim().length===0||s.busy,onClick:save,shape:"rectangular",size:"sm",variant:"secondary",children:s.busy?"Saving\u2026":changed?"Save":"Saved"}),
a.jsx(se,{as:"span",color:connected?"primary":"secondary",size:"sm",children:detail})]}),
s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})}

const ROpenGrokErrorCopy={no_org_key:["No computer set up yet","An admin can add box.ascii.dev for your organisation on the server’s admin dashboard."],invalid_key:["The box.ascii.dev key was rejected","It may be wrong, expired, or revoked. An admin can replace it on the dashboard."],quota_exceeded:["No capacity left at box.ascii.dev","Your organisation’s account is out of boxes or credit."],provider_unreachable:["Could not reach box.ascii.dev","The server could not get through. This usually clears on its own."],provider_error:["box.ascii.dev refused the request","The provider answered with a failure."],not_supported:["Not available on this server","This deployment does not offer the computer that was asked for."],unknown:["A computer could not be set up","The server did not say why."]};
function ROpenGrokReset({mode,onDone}){
  const[s,e]=de.useState({asking:!1,busy:!1,note:null,error:null});
  if(mode==="per-org")return a.jsx(ie,{divided:!0,description:"This computer belongs to your whole organisation. An admin can reset it from your server’s admin dashboard.",label:"Reset",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Admin only"})});
  const run=async()=>{e(i=>({...i,busy:!0,error:null,note:null}));
    try{const r=await window.desktop.agent.resetOpenGrokComputer();
      const failed=r&&r.computerError;
      e({asking:!1,busy:!1,error:failed?String(failed.message||failed.code||"The server could not set up a new computer."):null,
         note:failed?null:"Done. New computer is "+String((r&&r.state)||"starting")+"."});
      if(!failed&&onDone)onDone()}
    catch(err){e(i=>({...i,busy:!1,asking:!1,error:String(err&&err.message||err)}))}};
  return a.jsxs("div",{children:[
    a.jsx(ie,{divided:!0,label:"Reset this computer",variant:"card",
      description:s.asking
        ?"This destroys the computer and everything saved on it. A new one is set up from your organisation’s current settings. This cannot be undone."
        :"Throw this computer away and set up a fresh one. Its files are not kept.",
      children:s.asking
        ?a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4",style:{gap:8},children:[
            a.jsx(oe,{disabled:s.busy,onClick:()=>e(i=>({...i,asking:!1})),shape:"rectangular",size:"sm",variant:"secondary",children:"Cancel"}),
            a.jsx(oe,{disabled:s.busy,onClick:run,shape:"rectangular",size:"sm",variant:"secondary",children:s.busy?"Resetting…":"Reset and lose the files"})]})
        :a.jsx(oe,{onClick:()=>e(i=>({...i,asking:!0,note:null,error:null})),shape:"rectangular",size:"sm",variant:"secondary",children:"Reset…"})}),
    s.note?a.jsx(se,{as:"p",color:"secondary",size:"sm",style:{marginTop:8},children:s.note}):null,
    s.error?a.jsx(se,{as:"p",color:"red",size:"sm",style:{marginTop:8},children:s.error}):null]})}
function ROpenGrokRows(list,activeKind){return a.jsx("div",{children:list.map((c,i)=>{const kindName=ROpenGrokKind[c.kind]||(c.kind?String(c.kind):""),ready=c.configured!==!1,mine=c.active===!0||(activeKind!=null&&c.kind===activeKind),detail=[kindName,c.state?String(c.state):null].filter(Boolean).join(" \u00b7 ")||"On your OpenGrok server.",right=mine?"Your computer":ready?"Available to your org":"Set up by your org admin";return a.jsx(ie,{divided:i>0,description:detail,label:String(c.label||c.name||kindName||c.id),variant:"card",children:a.jsx(se,{as:"span",color:mine?"green":"secondary",size:"sm",children:right})},String(c.id))})})}
const RRemoteModes=[
  {value:"never",label:"Never"},
  {value:"ask",label:"Ask every time"},
  {value:"bypass",label:"Always allow"}];
function RRemoteControl(){
  const[s,e]=de.useState({loaded:!1,available:!1,enrolled:!1,machineId:null,mode:"never",allow:[],deny:[],busy:!1,error:null,confirming:!1});
  const load=()=>window.desktop.agent.getRemoteControl().then(r=>{if(r==null)return;
    e(i=>({...i,loaded:!0,available:!!r.available,enrolled:!!r.enrolled,machineId:r.machineId||null,
      mode:typeof r.mode==="string"?r.mode:"never",allow:r.allow||[],deny:r.deny||[],error:r.error||null}))})
    .catch(err=>e(i=>({...i,loaded:!0,error:String(err&&err.message||err)})));
  de.useEffect(()=>{load()},[]);
  if(!s.loaded)return null;
  if(!s.available)return null;
  const turnOn=async()=>{e(i=>({...i,busy:!0,error:null}));
    try{const name=(await window.desktop.agent.getLocalComputer().catch(()=>null))||{};
      await window.desktop.agent.enrolRemoteControl(String(name.name||name.hostname||"This computer"));
      await load();e(i=>({...i,busy:!1}))}
    catch(err){e(i=>({...i,busy:!1,error:String(err&&err.message||err)}))}};
  const turnOff=async()=>{e(i=>({...i,busy:!0,error:null,confirming:!1}));
    try{await window.desktop.agent.revokeRemoteControl();await load();e(i=>({...i,busy:!1}))}
    catch(err){e(i=>({...i,busy:!1,error:String(err&&err.message||err)}))}};
  const setMode=async v=>{const was=s.mode;e(i=>({...i,mode:v,error:null}));
    try{await window.desktop.agent.setRemoteControlMode(v)}
    catch(err){e(i=>({...i,mode:was,error:String(err&&err.message||err)}))}};
  if(!s.enrolled)return a.jsxs("div",{children:[
    a.jsx(ie,{variant:"card",label:"Let your bots use this computer",
      description:"Off. A bot on your server cannot reach this Mac at all. Turn this on and it can ask to run commands here — useful for reaching this machine from your phone, and worth understanding before you do it.",
      children:a.jsx(oe,{disabled:s.busy,onClick:turnOn,shape:"rectangular",size:"sm",variant:"secondary",children:s.busy?"Turning on…":"Turn on…"})}),
    s.error?a.jsx(se,{as:"p",color:"red",size:"sm",style:{marginTop:8},children:s.error}):null]});
  return a.jsxs("div",{children:[
    a.jsx(ie,{variant:"card",label:"Bots using this computer",
      description:s.mode==="never"?"On, but nothing may run: every request is refused."
        :s.mode==="ask"?"You are asked before anything runs here."
        :"Anything a bot asks for runs here without asking you first.",
      children:a.jsx(ye,{"aria-label":"Bots using this computer",onValueChange:setMode,options:RRemoteModes,
        placement:"bottom-end",size:"lg",value:s.mode,variant:"filled"})}),
    s.deny.length>0||s.allow.length>0?a.jsx(ie,{divided:!0,variant:"card",label:"Standing rules",
      description:"Commands you have already answered for. Managed from the prompt when it appears.",
      children:a.jsx(se,{as:"span",color:"secondary",size:"sm",
        children:String(s.allow.length)+" allowed, "+String(s.deny.length)+" denied"})}):null,
    a.jsx(ie,{divided:!0,variant:"card",label:"Turn off",
      description:s.confirming?"This computer stops being reachable and its credential is destroyed. You can turn it on again later.":"Stop your bots reaching this computer.",
      children:s.confirming
        ?a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4",style:{gap:8},children:[
            a.jsx(oe,{disabled:s.busy,onClick:()=>e(i=>({...i,confirming:!1})),shape:"rectangular",size:"sm",variant:"secondary",children:"Cancel"}),
            a.jsx(oe,{disabled:s.busy,onClick:turnOff,shape:"rectangular",size:"sm",variant:"secondary",children:s.busy?"Turning off…":"Turn off"})]})
        :a.jsx(oe,{onClick:()=>e(i=>({...i,confirming:!0})),shape:"rectangular",size:"sm",variant:"secondary",children:"Turn off…"})}),
    s.error?a.jsx(se,{as:"p",color:"red",size:"sm",style:{marginTop:8},children:s.error}):null]});
}
const RLocalPerm=[{value:"always",label:"On"},{value:"never",label:"Off"}];
function RLocalComputer(){
  const[s,e]=de.useState({name:"",hostname:"",isCustom:!1,draft:"",permission:null,ceiling:null,loaded:!1,saving:!1,error:null});
  de.useEffect(()=>{let alive=!0;
    Promise.all([
      window.desktop.agent.getLocalComputer().catch(()=>null),
      window.desktop.localToolPermission.get().catch(()=>null),
      window.desktop.localToolPermission.ceiling?window.desktop.localToolPermission.ceiling().catch(()=>null):Promise.resolve(null)
    ]).then(r=>{if(!alive)return;const c=r[0]||{},p=r[1];
      e(i=>({...i,name:c.name||"",hostname:c.hostname||"",isCustom:!!c.isCustom,draft:c.name||"",
        permission:typeof p==="string"?p:(p&&typeof p.permission==="string"?p.permission:null),
        ceiling:typeof r[2]==="string"?r[2]:(r[2]&&typeof r[2].permission==="string"?r[2].permission:null),
        loaded:!0}))}).catch(()=>{alive&&e(i=>({...i,loaded:!0}))});
    return()=>{alive=!1}},[]);
  const save=async()=>{const next=s.draft.trim();e(i=>({...i,saving:!0,error:null}));
    try{await window.desktop.agent.setLocalComputerName(next);
      const c=await window.desktop.agent.getLocalComputer().catch(()=>null);
      e(i=>({...i,saving:!1,name:(c&&c.name)||next,isCustom:!!(c&&c.isCustom),draft:(c&&c.name)||next}))}
    catch(err){e(i=>({...i,saving:!1,error:String(err&&err.message||err)}))}};
  const setPerm=async v=>{const was=s.permission;e(i=>({...i,permission:v,error:null}));
    try{await window.desktop.localToolPermission.set(v)}
    catch(err){e(i=>({...i,permission:was,error:String(err&&err.message||err)}))}};
  if(!s.loaded)return a.jsx(ie,{description:"The computer you are using now.",label:"This computer",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Loading…"})});
  const dirty=s.draft.trim()!==(s.name||"").trim();
  return a.jsxs("div",{children:[
    a.jsx(ie,{description:s.isCustom&&s.hostname?"Known to this network as "+s.hostname+".":"The computer you are using now.",label:"This computer",variant:"card",
      children:a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4",style:{gap:8},children:[
        a.jsx("input",{"aria-label":"Name for this computer",className:RRouterInputClass,disabled:s.saving,
          onChange:ev=>{const v=ev.currentTarget.value;e(i=>({...i,draft:v}))},
          placeholder:s.hostname||"This computer",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:230},value:s.draft}),
        a.jsx(oe,{disabled:s.saving||!dirty,onClick:save,shape:"rectangular",size:"sm",variant:"secondary",children:s.saving?"Saving…":"Save"})]})}),
    a.jsx(ie,{divided:!0,description:"When on, bots on your server can run commands on this computer. Turn it off to stop them, whatever a rule or the server says. Per-command consent still happens on the server.",label:"This computer accepts bot commands",variant:"card",
      children:a.jsx(ye,{"aria-label":"This computer accepts bot commands",onValueChange:setPerm,options:RLocalPerm,placement:"bottom-end",size:"lg",
        value:s.permission==null?null:s.permission==="never"?"never":"always",variant:"filled"})}),
    s.ceiling==="never"&&s.permission!=="never"?a.jsx(se,{as:"p",color:"secondary",size:"sm",children:"Your organisation has turned local execution off, so nothing will run here."}):null,
    s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})}
const ROpenGrokKind={"local-docker":"Local VM","ascii":"box (Linux)","windows365":"Windows 365"};
function ROpenGrokComputers(){const[s,e]=de.useState({computers:null,signedIn:!1,error:null,computerError:null,activeKind:null,sharingMode:null});
const load=()=>window.desktop.agent.listOpenGrokComputers().then(r=>{if(r==null)return;e({computers:r.computers||[],signedIn:!!r.signedIn,error:r.error||null,computerError:r.computerError||null,activeKind:r.activeKind||null,sharingMode:r.sharingMode||null})}).catch(err=>e(i=>({...i,error:String(err&&err.message||err)})));
de.useEffect(()=>{load();const onChange=()=>load();window.addEventListener("sand-opengrok-changed",onChange);const id=setInterval(load,3e4);return()=>{clearInterval(id);window.removeEventListener("sand-opengrok-changed",onChange)}},[]);
if(s.computers==null)return a.jsx(ie,{description:"Asking the server which computers it has.",label:"Computers",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Loading\u2026"})});
if(s.error)return a.jsx(ie,{description:"The server did not answer. It may be an older build without the computer list.",label:"Computers",variant:"card",children:a.jsx(se,{as:"span",color:"red",size:"sm",children:String(s.error).slice(0,80)})});
if(s.computerError){const known=ROpenGrokErrorCopy[s.computerError.code],detail=String(s.computerError.message||"").trim(),c=known||(detail?["A computer could not be set up",detail]:ROpenGrokErrorCopy.unknown);return a.jsxs("div",{children:[a.jsx(ie,{description:c[1],label:c[0],variant:"card",children:a.jsx(se,{as:"span",color:"red",size:"sm",children:"No computer"})}),detail&&known?a.jsx(se,{as:"p",color:"secondary",size:"sm",style:{marginTop:8},children:detail}):null,s.computers.length>0?a.jsx("div",{style:{marginTop:8},children:ROpenGrokRows(s.computers,s.activeKind)}):null]})}
if(s.computers.length===0)return a.jsx(ie,{description:"A computer is added for your whole organisation, on your server\u2019s admin dashboard. Until then your bots run on the server itself.",label:"Computers",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"None yet"})});
return a.jsxs("div",{children:[ROpenGrokRows(s.computers,s.activeKind),a.jsx(ROpenGrokReset,{mode:s.sharingMode,onDone:load})]})}

function RBoxRuntime(){const all=[{value:"remote",label:"Grok VM"},{value:"local-docker",label:"Local VM"},{value:"windows365",label:"Windows 365"},{value:"opengrok",label:"OpenGrok Server"}];const[s,e]=de.useState(()=>RBoxLast??{mode:ROpenGrokSeeded()?"opengrok":null,provider:null,status:null,error:null,busy:!1,windows365:null,account:null});de.useEffect(()=>{let t=!0;const apply=r=>{if(!t||r==null)return;e(i=>{const next={...i,mode:i.busy?i.mode:typeof r.mode==="string"?r.mode:i.mode,status:r.status??null,windows365:r.windows365??null,account:r.account??null,error:null};RBoxLast=next;return next})};const load=()=>window.desktop.agent.getBoxRuntime().then(apply).catch(r=>{t&&e(i=>({...i,error:String(r&&r.message||r)}))});window.desktop.agent.getInferenceRouter().then(r=>{if(!t||r==null)return;e(i=>{const next={...i,provider:typeof r.provider==="string"?r.provider:i.provider};RBoxLast=next;return next})}).catch(()=>{});const onProvider=n=>{const p=n&&n.detail&&n.detail.provider;if(typeof p==="string")e(i=>({...i,provider:p}))};window.addEventListener("sand-router-provider-changed",onProvider);load();const id=setInterval(load,15e3);return()=>{t=!1;clearInterval(id);window.removeEventListener("sand-router-provider-changed",onProvider)}},[]);const RBoxOptions=s.provider==="cursor"?all:all.filter(n=>n.value!=="remote"||n.value==="opengrok");const t=async n=>{if(n==null)return;if(n==="remote"&&s.provider!=="cursor")n="local-docker";e(i=>({...i,mode:n,busy:!0,error:null}));try{const r=await window.desktop.agent.setBoxRuntime(n);try{if(self.__sandSetOpenGrokMode)self.__sandSetOpenGrokMode(n==="opengrok")}catch(_){}e(i=>({...i,mode:n,status:r&&r.status||null,windows365:r&&r.windows365||null,account:r&&r.account||null,busy:!1}));window.dispatchEvent(new CustomEvent("sand-box-runtime-changed",{detail:{mode:n}}))}catch(r){e(i=>({...i,mode:n,busy:!1,error:String(r&&r.message||r)}))}};const n=s.mode==="opengrok"?"Your OpenGrok server holds the bots and runs their work.":s.mode==="windows365"?"Enter Windows 365 credentials below, then Save and Connect.":s.mode==="remote"?(s.account&&s.account.detail||"Uses the Cursor account already signed into Grok Bot."):(s.status&&s.status.detail||"A Linux desktop in Docker on this Mac.");if(s.mode==="opengrok")return a.jsx(ROpenGrokComputers,{});return a.jsxs("div",{children:[a.jsx(ie,{description:n,label:"Computer for this account",variant:"card",children:a.jsx(ye,{"aria-label":"Computer for this account",onValueChange:t,options:RBoxOptions,placement:"bottom-end",size:"lg",value:s.mode==null?null:RBoxOptions.some(r=>r.value===s.mode)?s.mode:"local-docker",variant:"filled"})}),s.mode==="windows365"?a.jsxs("div",{style:{marginTop:8},children:[a.jsx(se,{as:"p",size:"sm",children:"Windows 365 credentials"}),a.jsx(RW365Setup,{})]}):null,s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:String(s.error)}):null]})}
function RRouterPanel(){const[s,e,g,u]=RRouterState(),[t,n]=RRouterSecrets(),r=RRouterProviders.find(i=>i.value===s.provider)??RRouterProviders[0],i=s.usage?.providers?.[s.provider]??RRouterEmptyUsage,o=r.value==="codex"?"Official Codex/ChatGPT login on this Mac.":r.kind==="local"?"Official Claude login on this Mac.":r.kind==="key"?"Stored with your other Grok Bot secrets.":"Uses the account already connected to Grok Bot.";return a.jsx(Te,{children:a.jsxs("div",{className:k("sand-settings-general","sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x"),children:[a.jsx(re,{title:"Computer",children:a.jsx(RBoxRuntime,{})}),a.jsx(re,{title:"This computer",children:a.jsx(RLocalComputer,{})}),a.jsx(re,{title:"Remote control",children:a.jsx(RRemoteControl,{})}),a.jsx(re,{title:"Performance",children:a.jsx(RHardwareAcceleration,{})}),r.kind==="key"?a.jsx(re,{title:"Model",children:a.jsx(ie,{description:"Any OpenRouter model id, including :free models.",label:"Model",variant:"card",children:a.jsx(ROpenRouterModel,{model:s.openRouterModel,onSaved:l=>u(c=>({...c,openRouterModel:l.openRouterModel??l.model??c.openRouterModel,error:null}))})})}):null,s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})})}
function RHardwareAcceleration(){
  const[t,n]=de.useState({enabled:!0,restartRequired:!1,changed:!1});
  de.useEffect(()=>{let c=!0;window.desktop.getHardwareAcceleration().then(d=>{if(c&&d)n(h=>({...h,enabled:d.enabled===!0}))}).catch(()=>{});return()=>{c=!1}},[]);
  const g=async c=>{n(d=>({...d,enabled:c}));try{await window.desktop.setHardwareAcceleration(c);n(d=>({...d,changed:!0}))}catch{}};
  return a.jsxs("div",{children:[
    a.jsx(ie,{description:"Uses the Mac's GPU for rendering (Metal), like official Grok Bot 0.29. Turn off only if you see visual glitches.",label:"Hardware acceleration",variant:"card",children:a.jsx(ye,{"aria-label":"Hardware acceleration",onValueChange:c=>{if(c!=null)void g(c==="on")},options:[{value:"on",label:"On"},{value:"off",label:"Off"}],placement:"bottom-end",size:"lg",value:t.enabled?"on":"off",variant:"filled"})}),
    t.changed?a.jsx(se,{as:"p",color:"secondary",size:"sm",children:"Takes effect after quitting and reopening Grok Bot."}):null
  ]})
}
function RDictationPanel(){const[t,n]=RRouterSecrets();return a.jsx(Te,{children:a.jsx("div",{className:k("sand-settings-general","sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x"),children:a.jsx(re,{title:"Transcription",children:a.jsx(RTranscribe,{keys:t,onSaved:n})})})})}
function RRouterUsageSummary({provider:s,usage:e,current:t,divided:n}){const r=[RRouterNumber(e.requests)+" requests",RRouterNumber(e.inputTokens)+" input",RRouterNumber(e.outputTokens)+" output",RRouterNumber(e.cacheReadTokens+e.cacheWriteTokens)+" cached"].join(" · "),i=t?"Current route":e.lastUsedAt?new Date(e.lastUsedAt).toLocaleString():"Not used yet";return a.jsx(ie,{divided:n,description:r,label:s.label,variant:"card",children:a.jsx(se,{as:"span",color:t?"primary":"secondary",size:"sm",children:i})})}
function RRouterUsage(){const[s]=RRouterState(),e=RRouterProviders.find(t=>t.value===s.provider)??RRouterProviders[0],t=RRouterProviders.filter(n=>n.value===s.provider||(s.usage?.providers?.[n.value]?.requests??0)>0);const og=ROpenGrokActive();if(og)return a.jsxs("div",{className:k("sand-usage-section","sand-9f619 sand-78zum5 sand-dt5ytf sand-ou54vl"),children:[a.jsx(re,{title:"Current provider",children:a.jsx(ie,{description:"Work runs on your OpenGrok server, on each coworker\u2019s own model.",label:"OpenGrok Server",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Selected"})})})]});return a.jsxs("div",{className:k("sand-usage-section","sand-9f619 sand-78zum5 sand-dt5ytf sand-ou54vl"),children:[a.jsx(re,{title:"Current provider",children:a.jsx(ie,{description:e.description,label:e.label,variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Selected"})})}),a.jsx(re,{title:"Tracked activity",children:a.jsx("div",{children:t.map((n,r)=>a.jsx(RRouterUsageSummary,{provider:n,usage:s.usage?.providers?.[n.value]??RRouterEmptyUsage,current:n.value===s.provider,divided:r>0},n.value))})}),s.provider==="cursor"?a.jsx(Na,{}):null]})}
`;

export const MAIN_CHROME_SOURCE = String.raw`
const RAgentIssueCopy={
  no_org_key:"No computer is set up for your organisation, so this bot has none.",
  invalid_key:"Your organisation\u2019s box.ascii.dev key was rejected, so this bot has no computer.",
  quota_exceeded:"Your organisation has no capacity left at box.ascii.dev, so this bot has no computer.",
  provider_unreachable:"The computer provider could not be reached, so this bot has no computer yet.",
  provider_error:"The computer provider refused, so this bot has no computer.",
  not_supported:"This server does not offer the computer this bot asked for.",
  unknown:"This bot has no computer."};
const RAgentIssues={map:{},at:0};
function RAgentIssueBar(){
  try{
    const row=document.querySelector(".sand-agent-item[data-agent-id][data-active=\"true\"]");
    const id=row?row.getAttribute("data-agent-id"):null;
    const existing=document.querySelector("[data-sand-agent-issue]");
    const issue=id?RAgentIssues.map[id]:null;
    if(!issue){if(existing)existing.remove();return}
    if(!document.querySelector("[data-sand-agent-issue-style]")){
      const st=document.createElement("style");st.setAttribute("data-sand-agent-issue-style","1");
      st.textContent="[data-sand-agent-issue]{position:fixed;left:50%;bottom:150px;transform:translateX(-50%);z-index:2147483400;max-width:min(520px,92vw);padding:9px 14px;border-radius:10px;font-size:12.5px;line-height:1.5;text-align:center;border:1px solid var(--sand-border-default,rgba(128,128,128,.3));background:var(--sand-bg-elevated,Canvas);color:var(--sand-text-primary,CanvasText);box-shadow:0 10px 28px rgba(0,0,0,.24)}";
      document.head.appendChild(st);
    }
    const said=RAgentIssueCopy[issue.code]||issue.message||RAgentIssueCopy.unknown;
    const detail=RAgentIssueCopy[issue.code]&&issue.message?" "+issue.message:"";
    const text=said+detail;
    let bar=existing;
    if(!bar){bar=document.createElement("div");bar.setAttribute("data-sand-agent-issue","1");
      bar.setAttribute("role","status");bar.setAttribute("aria-live","polite");document.body.appendChild(bar)}
    if(bar.textContent!==text)bar.textContent=text;
  }catch{}
}
function RInstallAgentIssues(){
  try{
    if(typeof document==="undefined")return;
    const load=function(){
      try{Promise.resolve(window.desktop.agent.getOpenGrokAgentIssues()).then(function(r){
        const next={};(r&&r.issues||[]).forEach(function(i){next[i.agentId]=i});
        RAgentIssues.map=next;RAgentIssues.at=Date.now();RAgentIssueBar();
      }).catch(function(){})}catch(_){}
    };
    load();setInterval(load,60000);setInterval(RAgentIssueBar,3000);
  }catch{}
}
const RTurnStop={since:0,agent:null,busy:!1};
function RTurnStopBar(){
  const dot=document.querySelector(".sand-kit-status-dot");
  const row=document.querySelector(".sand-agent-item[data-agent-id][data-active=\"true\"]")||document.querySelector(".sand-agent-item[data-agent-id]");
  const agent=row?row.getAttribute("data-agent-id"):null;
  const existing=document.querySelector("[data-sand-turn-stop]");
  if(dot==null||agent==null){RTurnStop.since=0;RTurnStop.agent=null;if(existing)existing.remove();return}
  if(RTurnStop.agent!==agent){RTurnStop.agent=agent;RTurnStop.since=Date.now();if(existing)existing.remove();return}
  if(RTurnStop.since===0)RTurnStop.since=Date.now();
  const seconds=Math.floor((Date.now()-RTurnStop.since)/1000);
  if(seconds<45){if(existing)existing.remove();return}
  if(!document.querySelector("[data-sand-turn-stop-style]")){
    const st=document.createElement("style");st.setAttribute("data-sand-turn-stop-style","1");
    st.textContent="[data-sand-turn-stop]{position:fixed;left:50%;bottom:104px;transform:translateX(-50%);z-index:2147483500;display:flex;align-items:center;gap:12px;padding:9px 12px 9px 16px;border-radius:11px;font-size:13px;border:1px solid var(--sand-border-default,rgba(128,128,128,.3));background:var(--sand-bg-elevated,Canvas);color:var(--sand-text-primary,CanvasText);box-shadow:0 12px 34px rgba(0,0,0,.28)}"
      +"[data-sand-turn-stop] button{font:inherit;font-size:12.5px;padding:5px 11px;border-radius:8px;cursor:pointer;border:1px solid var(--sand-border-default,rgba(128,128,128,.32));background:var(--sand-fill-ghost-hover,rgba(128,128,128,.10));color:inherit}"
      +"[data-sand-turn-stop] button:disabled{opacity:.5;cursor:default}";
    document.head.appendChild(st);
  }
  const minutes=Math.floor(seconds/60);
  const label=minutes>=1?("This has been running for "+minutes+" minute"+(minutes===1?"":"s")+"."):"This has been running a while.";
  let bar=existing;
  if(!bar){
    bar=document.createElement("div");bar.setAttribute("data-sand-turn-stop","1");
    bar.setAttribute("role","status");bar.setAttribute("aria-live","polite");
    const text=document.createElement("span");text.setAttribute("data-sand-turn-stop-text","1");
    const button=document.createElement("button");button.type="button";button.textContent="Stop";
    button.addEventListener("click",function(){
      if(RTurnStop.busy)return;RTurnStop.busy=!0;button.disabled=!0;button.textContent="Stopping\u2026";
      const done=function(msg){RTurnStop.busy=!1;RTurnStop.since=0;
        const t=bar.querySelector("[data-sand-turn-stop-text]");if(t&&msg)t.textContent=msg;
        setTimeout(function(){try{bar.remove()}catch{}},msg?4000:0)};
      try{
        Promise.resolve(window.desktop.agent.stopOpenGrokAgentTurn(RTurnStop.agent))
          .then(function(){done()})
          .catch(function(err){done("Could not stop it: "+String(err&&err.message||err).slice(0,90))});
      }catch(err){done("Could not stop it: "+String(err&&err.message||err).slice(0,90))}
    });
    bar.append(text,button);document.body.appendChild(bar);
  }
  const t=bar.querySelector("[data-sand-turn-stop-text]");
  if(t&&!RTurnStop.busy)t.textContent=label;
}
function RInstallTurnStop(){
  try{
    if(typeof document==="undefined")return;
    setInterval(RTurnStopBar,3000);RTurnStopBar();
  }catch{}
}
function RSendNotDelivered(){
  try{
    const existing=document.querySelector("[data-sand-send-blocked]");
    if(existing)existing.remove();
    if(!document.querySelector("[data-sand-send-blocked-style]")){
      const st=document.createElement("style");
      st.setAttribute("data-sand-send-blocked-style","1");
      st.textContent="[data-sand-send-blocked]{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483600;max-width:min(460px,92vw);padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.45;text-align:center;border:1px solid var(--sand-border-default,rgba(128,128,128,.3));background:var(--sand-bg-elevated,Canvas);color:var(--sand-text-primary,CanvasText);box-shadow:0 12px 34px rgba(0,0,0,.28);animation:sand-sb-in .18s ease-out}"
        +"@keyframes sand-sb-in{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translateX(-50%)}}";
      document.head.appendChild(st);
    }
    const n=document.createElement("div");
    n.setAttribute("data-sand-send-blocked","1");
    n.setAttribute("role","status");
    n.setAttribute("aria-live","polite");
    n.textContent="This chat is still opening, so the message was not sent. Your text is still here \u2014 try again in a moment.";
    document.body.appendChild(n);
    setTimeout(()=>{try{n.remove()}catch{}},6000);
  }catch{}
}
const RBoxWaking=new Map();
function RBoxOpenPlaceholder(view,localMessage){
  const off=(()=>{try{
    if(view==null||view.isStatusUnavailable||!view.isStatusKnown)return!1;
    const st=view.status&&typeof view.status.state==="string"?view.status.state:null;
    return st!=null&&st!=="running";
  }catch{return!1}})();
  let waking=!1;
  if(off&&view&&typeof view.ensure==="function"){
    try{
      const key=(view.status&&view.status.agentId)||"one";
      const now=Date.now(),started=RBoxWaking.get(key)||0;
      if(now-started>60000){RBoxWaking.set(key,now);setTimeout(function(){try{Promise.resolve(view.ensure()).catch(function(){})}catch(_){}} ,0);waking=!0}
      else waking=now-started<40000;
    }catch{}
  }
  const running=view!=null&&view.isStatusKnown&&view.status&&view.status.state==="running";
  const screenExpected=running&&!RBoxHasNoScreen(view)&&view.vncUrl==null;
  if(screenExpected&&view&&typeof view.retryStatus==="function"){
    try{
      const key=((view.status&&view.status.agentId)||"one")+":screen";
      const now=Date.now(),first=RBoxWaking.get(key)||0;
      if(first===0)RBoxWaking.set(key,now);
      else if(now-first<90000&&now-(RBoxWaking.get(key+":at")||0)>2500){
        RBoxWaking.set(key+":at",now);setTimeout(function(){try{view.retryStatus()}catch(_){}} ,0);
      }
    }catch{}
  }else if(view&&view.status&&view.status.agentId){
    try{RBoxWaking.delete(view.status.agentId+":screen");RBoxWaking.delete(view.status.agentId+":screen:at")}catch{}
  }
  const stated=RBoxEmptyMessage(view)??(view&&view.phase==="local"?localMessage:void 0);
  const stalled=off&&!waking&&RBoxWaking.size>0;
  const message=waking?"Waking this computer up\u2026"
    :screenExpected?"Starting the desktop\u2026"
    :stalled?"This computer did not come up. The bot can still be asked to use it, which wakes it too."
    :stated;
  return{emptyMessage:message,isEmptyLoading:waking||screenExpected};
}
function RBoxHasNoScreen(view){
  try{return view!=null&&view.phase==="local"}catch{return!1}
}
function RBoxEmptyMessage(view){
  try{
    if(view==null||view.isStatusUnavailable)return void 0;
    if(!view.isStatusKnown)return void 0;
    const state=view.status&&typeof view.status.state==="string"?view.status.state:null;
    if(state==null)return void 0;
    if(state==="running"){
      if(RBoxHasNoScreen(view))return "This computer has no screen. It runs commands and files for this bot.";
      return void 0;
    }
    if(state==="stopped")return "This computer is asleep. Send a message and it wakes up.";
    if(state==="absent")return "This bot has no computer yet.";
    return "This computer is "+state+".";
  }catch{return void 0}
}
function RLoginWallSkipped(){try{return localStorage.getItem("sand-cursor-login-skip")==="1"&&localStorage.getItem("sand-opengrok-mode")!=="1"}catch{return!1}}
function RRememberLoginWallSkip(){try{localStorage.setItem("sand-cursor-login-skip","1")}catch{}}
function ROpenRouterSettings(){const labeled=n=>(n.getAttribute("aria-label")||n.textContent||"").trim();const click=label=>{const el=[...document.querySelectorAll("button,[role=tab],[role=menuitem]")].find(n=>labeled(n)===label);if(el){el.click();return!0}return!1};const fire=()=>{if(click("Router"))return!0;window.dispatchEvent(new KeyboardEvent("keydown",{key:",",code:"Comma",keyCode:188,which:188,metaKey:!0,ctrlKey:!1,bubbles:!0,cancelable:!0}));click("Settings");return click("Router")};let n=0;const id=setInterval(()=>{if(fire()||++n>50)clearInterval(id)},200)}
async function RSkipLoginWall(){RRememberLoginWallSkip();try{sessionStorage.setItem("sand-open-router-settings","1")}catch{}const agent=window.desktop&&window.desktop.agent;if(agent&&agent.skipCursorLoginWall)try{await agent.skipCursorLoginWall({})}catch{}window.location.reload()}
function RInstallFirstRunLogins(){if(RLoginWallSkipped()){try{if(sessionStorage.getItem("sand-open-router-settings")==="1"){sessionStorage.removeItem("sand-open-router-settings");ROpenRouterSettings()}}catch{}}const hide=()=>{if(!RLoginWallSkipped())return;document.querySelectorAll(".sand-onboarding").forEach(n=>n.style.setProperty("display","none","important"))};hide();new MutationObserver(hide).observe(document.documentElement,{childList:!0,subtree:!0})}
RInstallTurnStop();
RInstallAgentIssues();
function RInstallScreenSwitcher(){const labels={"local-docker":"Local Docker VM","grok-vm":"Grok VM","windows-365":"Windows 365",box:"box (Linux VM)"};const mount=s=>{if(!s||s.querySelector("[data-computer-screen-switcher]"))return;const e=document.createElement("div");e.className="sand-computer-screen-switcher";e.setAttribute("data-computer-screen-switcher","1");const t=async()=>{try{const n=window.desktop.agent.getProviderComputers?await window.desktop.agent.getProviderComputers():await window.desktop.agent.getInferenceRouter(),r=n.computers??n,i=Array.isArray(r.activated)?r.activated:[],o=r.selectedScreen??i[0]??null;e.replaceChildren();if(i.length<=1){e.style.display="none";if(i[0])s.setAttribute("data-active-computer-screen",i[0]);return}e.style.display="";{const l=document.createElement("div");l.setAttribute("role","tablist");l.setAttribute("aria-label","Computer screen");i.forEach(c=>{const d=document.createElement("button");d.type="button";d.setAttribute("role","tab");d.setAttribute("data-computer-screen",c);d.setAttribute("aria-selected",c===o?"true":"false");d.textContent=labels[c]??c;d.addEventListener("click",()=>{void window.desktop.agent.setComputerScreen(c).then(()=>{window.dispatchEvent(new CustomEvent("sand-computer-screen-changed",{detail:{screen:c}}));void t()})});l.append(d)});e.append(l)}if(o)s.setAttribute("data-active-computer-screen",o)}catch{}};s.prepend(e);void t();window.addEventListener("sand-router-provider-changed",t);window.addEventListener("sand-computer-screen-changed",t)};const scan=()=>{const target=document.querySelector(".sand-computer-preview")??document.querySelector(".sand-info-pane")??document.querySelector("[aria-label='Conversation details']");if(target)mount(target)};scan();new MutationObserver(scan).observe(document.documentElement,{childList:!0,subtree:!0})}
if(typeof document!=="undefined"){const RBootProviderChrome=()=>{RInstallFirstRunLogins();RInstallScreenSwitcher()};if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",RBootProviderChrome);else RBootProviderChrome()}
`;

export function containsUnquotedCodexIdentifier(source) {
  const visit = (program) => {
    let found = false;
    walkSimple(program, {
      Identifier(node) {
        if (node.name === "codex") found = true;
      },
    });
    return found;
  };
  try {
    return visit(parse(source, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true }));
  } catch {
    try {
      return visit(parse(`void function(){${source}}`, { ecmaVersion: "latest", sourceType: "script" }));
    } catch {
      return /(?:^|[^'"\w])codex(?:[^'"\w]|$)/.test(source.replace(/['"`]codex['"`]/g, ""));
    }
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + 1) >= 0) throw new Error(`Original renderer ${label} anchor is missing or ambiguous.`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

// Transcript images now stream through the media protocol like videos do, so
// img-src needs the scheme media-src already trusts.
const CSP_IMG_BEFORE = "img-src 'self' data: file: https:";
const CSP_IMG_AFTER = "img-src 'self' data: file: https: sand-media:";

// Square transcript tiles (user request): every image tile in the transcript
// renders 200x200 and cover-crops, regardless of Dj variant — single reserved
// images, assistant strips, and user galleries alike. !important intentionally
// beats the reserved-box inline styles; the media viewer and composer chips
// live outside .sand-virtual-transcript and keep their own sizing.
const TILE_CROP_STYLE = "<style>"
  // Image layout policy: single images render true aspect at a locked 200px
  // height; the dimension-less fallback (identified by its inline
  // aspect-ratio, since both branches write an inline width) is a 200px
  // cover-cropped square until the backfill persists real sizes. Multi-image
  // rows use uniform equal-width cells like iMessage/WhatsApp — cell size
  // depends only on the count, never on image aspect, so layout can never
  // break sizing.
  + ".sand-virtual-transcript .sand-attachment__image-frame:not([style*=height]){height:200px!important}"
  + ".sand-virtual-transcript .sand-attachment__image-frame{max-height:200px!important;max-width:100%!important}"
  + ".sand-virtual-transcript .sand-attachment__image-frame[style*=aspect-ratio]{width:200px!important;max-width:200px!important;aspect-ratio:auto!important}"
  + ".sand-virtual-transcript .sand-attachment__image-frame .sand-attachment__image-button{width:100%!important;height:100%!important}"
  + ".sand-virtual-transcript .sand-attachment__image-frame .sand-attachment__image{width:100%!important;height:100%!important;object-fit:cover}"
  + ".sand-virtual-transcript .sand-attachment__image-frame .sand-attachment__image-skeleton{width:100%!important;height:100%!important}"
  // Gallery rows keep the app's OWN planned height (Ni.plan: the shortest
  // source clamped to 64-192px) instead of a forced 200 - forcing 200 scaled
  // short sources up to 2.9x, which the layout lint caught across a whole
  // thread. 200 stays as the ceiling; uniform cell widths (below) are
  // unchanged, so the locked gallery look holds.
  + ".sand-virtual-transcript .sand-image-row{display:flex!important;gap:6px!important;height:200px!important;max-height:none!important;max-width:100%!important}"
  + ".sand-virtual-transcript .sand-image-row__tile:not(:only-child){flex:1 1 0!important;width:auto!important;min-width:0!important;max-width:280px!important;overflow:hidden!important}"
  + ".sand-virtual-transcript .sand-image-row__tile{height:200px!important}"
  + ".sand-virtual-transcript .sand-image-row__tile:only-child{flex:0 1 auto!important;max-width:100%!important}"
  + ".sand-virtual-transcript .sand-image-row__tile:not(:only-child) .sand-attachment__image-frame{width:100%!important;max-width:none!important}"
  + ".sand-virtual-transcript .sand-image-row__tile img{width:100%!important;height:100%!important;object-fit:cover}"
  // Cover-filling a cell with a source too small to fill it means scaling the
  // picture UP - the layout lint measured up to 2.07x, which reads as blur.
  // Those tiles letterbox instead: the cell keeps its content-independent
  // 200px height (so row heights, and therefore scroll stability, are
  // untouched) and the picture is drawn at most 1:1 inside it.
  // scale-down = never enlarge: a source smaller than its box draws at its
  // own size instead of being stretched (contain would still upscale it).
  + ".sand-virtual-transcript img.sand-fit-natural{object-fit:scale-down!important;background:rgba(127,127,127,.07)}"
  + ''
  + ".sand-attachment__image{object-fit:cover}"
  // Jump-to-newest pill: a floating control shown when the transcript is
  // scrolled away from the bottom. Dark translucent surface reads on both
  // themes (the universal chat-app convention); anchored over the transcript.
  // z-index 40 put the pill in the root stacking context above the app's own
  // chrome, so it floated over the composer and stayed on screen over the
  // fullscreen computer view. It only ever needs to clear transcript rows.
  + ".sand-jump-newest{position:fixed;z-index:5;display:flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;margin:0;border-radius:999px;border:1px solid rgba(0,0,0,.06);background:#fff;color:#2f2f34;cursor:pointer;box-shadow:0 0 0 1px rgba(0,0,0,.04);transform:translateX(-50%);transition:opacity .14s ease,transform .14s ease}"
  + "html[data-theme*=dark] .sand-jump-newest{background:#2c2c30;color:#e8e8ec;border-color:rgba(255,255,255,.14);box-shadow:0 0 0 1px rgba(255,255,255,.06)}"
  + ".sand-jump-newest[hidden]{display:none}"
  + ".sand-jump-newest:hover{transform:translateX(-50%) translateY(-1px)}"
  + ".sand-jump-newest:focus-visible{outline:2px solid #4b9;outline-offset:2px}"
  + ".sand-jump-newest svg{width:17px;height:17px;display:block}"
  + "@media (prefers-reduced-motion: reduce){.sand-jump-newest{transition:none}.sand-jump-newest:hover{transform:translateX(-50%)}}"
  // KaTeX MathML: no glyph fonts needed (native MathML), so only layout rules.
  // Display math scrolls inside its own box, never widening the transcript.
  + ".katex{font-size:1.05em;line-height:normal}"
  + ".katex-display{display:block;margin:.55em 0;text-align:center;overflow-x:auto;overflow-y:hidden;max-width:100%}"
  + ".katex-display>.katex{display:inline-block;text-align:initial;max-width:100%}"
  + ".katex .katex-html{display:none}"
  + ".sand-math-display{display:block;margin:.55em 0;text-align:center;overflow-x:auto}"
  + "</style>";

const KATEX_BUNDLE_PREPEND = KATEX_JS + "\n;" + REMARK_MATH_JS + "\n;" + MATH_KIT_JS + "\n";

export function patchOriginalRendererHtml(source) {
  const patched = replaceExactlyOnce(source, CSP_IMG_BEFORE, CSP_IMG_AFTER, "img-src media scheme");
  return replaceExactlyOnce(patched, "</head>", `${TILE_CROP_STYLE}</head>`, "tile crop style");
}

// The screen pane embeds live noVNC even for the tiny preview, and the stock
// URL carries no encoding hints, so the thumbnail decodes near-full-quality
// frames and taxes the compositor while an agent shares its screen. Ask noVNC
// for cheap frames on the passive preview; interactive view stays sharp.
const VNC_URL_BEFORE = 'function abn(n,e){const t=new URL(n);return t.searchParams.set("autoconnect","true"),t.searchParams.set("resize","scale"),t.searchParams.set("reconnect","true"),e&&t.searchParams.set("sandInteractive","1"),t.toString()}';
const VNC_URL_AFTER = 'function abn(n,e){const t=new URL(n);return t.searchParams.set("autoconnect","true"),t.searchParams.set("resize","scale"),t.searchParams.set("reconnect","true"),t.searchParams.set("quality",e?"6":"2"),t.searchParams.set("compression","9"),e&&t.searchParams.set("sandInteractive","1"),t.toString()}';

export function patchOriginalVncQuality(source) {
  return replaceExactlyOnce(source, VNC_URL_BEFORE, VNC_URL_AFTER, "vnc preview quality");
}

// Uniform-height image tiles: the stock math clamps tall images to 200px but
// width-caps wide ones, so short panoramas sat next to tall squares and rows
// jumped between container sizes. Every sized image now reserves exactly
// 200px of height (96px minimum width); the img cover-crops the overflow and
// the full picture stays one click away in the media viewer.
const IMAGE_TILE_BEFORE = "function y7n(n,e,t){if(n==null||e==null||n<=0||e<=0)return null;const s=n/e;let r=Math.min(n,t),i=r/s;return i>TTe&&(i=TTe,r=i*s),{width:Math.round(r),height:Math.round(i)}}";
// Height is min(200, natural): a 272x54 strip must render 272x54, not be
// cover-upscaled 3.7x into a 320x200 box (which reads as a permanent blur).
// Still deterministic from stored dims, so the virtualizer stays estimator-
// safe; the 96px width floor only applies when it will not force upscaling.
// Clamp box for single images: height is capped at 200 and never upscales,
// width follows the aspect capped by the container - and when THAT cap binds
// the height comes back down to match, so the box keeps the picture's shape
// instead of cover-cropping it (a 1102x264 banner in a 320px context was
// losing 62% of its width; the layout lint flagged it).
const IMAGE_TILE_AFTER = "function y7n(n,e,t){if(n==null||e==null||n<=0||e<=0)return null;const s=n/e;let i=Math.min(TTe,e),r=Math.min(i*s,t);return r<96&&n>=96&&(r=96),{width:Math.round(r),height:Math.round(i)}}";

export function patchOriginalImageTiles(source) {
  return replaceExactlyOnce(source, IMAGE_TILE_BEFORE, IMAGE_TILE_AFTER, "uniform image tiles");
}

// The 664px Show more collapse (UPn) only wrapped user bubbles; assistant
// bubbles of any length kept unbounded row heights, the largest source of
// virtualizer estimate error. Settled assistant messages now clamp the same
// way; streaming messages stay unclamped so growth and bottom-pinning behave.
const ASSISTANT_CLAMP_BEFORE = 'children:p.jsx(xAe,{isTrusted:k,children:p.jsx(JPn,{cachedLinkUrls:nMn,content:r,isStreaming:h,matcher:b,promoteStandaloneLinks:!1})})})';
const ASSISTANT_CLAMP_AFTER = 'children:(bw=>h?bw:p.jsx(UPn,{children:bw}))(p.jsx(xAe,{isTrusted:k,children:p.jsx(JPn,{cachedLinkUrls:nMn,content:r,isStreaming:h,matcher:b,promoteStandaloneLinks:!1})}))})';

export function patchOriginalAssistantClamp(source) {
  return replaceExactlyOnce(source, ASSISTANT_CLAMP_BEFORE, ASSISTANT_CLAMP_AFTER, "assistant show-more clamp");
}

// UPn (the Show more clamp) re-reads scrollHeight — a forced layout — on every
// ResizeObserver fire. Fine on a handful of user bubbles, but clamping settled
// assistant bubbles put an observer on every message and fast scrolling spent
// ~1.4s/5s in that callback (profiled). Width-gate the observer (scroll never
// changes width) and batch re-measures through rAF; the mount-time measure
// stays synchronous so bubbles clamp before first paint.
const CLAMP_OBSERVER_BEFORE = 'l=x=>{if(x==null)return;const N=()=>{o(x.scrollHeight>zPn)};N();const E=new ResizeObserver(N);return E.observe(x),()=>E.disconnect()}';
const CLAMP_OBSERVER_AFTER = 'l=x=>{if(x==null)return;let W=0,R=0;const N=()=>{R=0;o(x.scrollHeight>zPn)};R=requestAnimationFrame(N);const E=new ResizeObserver(es=>{const cw=es[es.length-1].contentRect.width;if(cw===W)return;W=cw;R||(R=requestAnimationFrame(N))});return E.observe(x),()=>{E.disconnect(),R&&cancelAnimationFrame(R)}}';

export function patchOriginalClampObserver(source) {
  return replaceExactlyOnce(source, CLAMP_OBSERVER_BEFORE, CLAMP_OBSERVER_AFTER, "clamp observer thrash");
}

// CSS-first clamp: the rAF-batched measure killed the layout thrash but let
// tall bubbles paint full-height for one frame before clamping, which moved
// row heights again. Tag the clamp root and pre-clamp it in CSS so bubbles
// are born at their final height; :has() lifts the cap when expanded, and
// the JS measure only decides whether the Show more button appears.
const CLAMP_ROOT_BEFORE = 'p.jsxs("div",{className:y.className,children:[k,v]})';
const CLAMP_ROOT_AFTER = 'p.jsxs("div",{"data-sand-clamp":"1",className:y.className,children:[k,v]})';

export function patchOriginalClampRoot(source) {
  return replaceExactlyOnce(source, CLAMP_ROOT_BEFORE, CLAMP_ROOT_AFTER, "clamp root marker");
}

// Real trackpad scrolling waited on the transcript's non-passive wheel
// listener (the horizontal timestamp-peek gesture) before every scroll tick,
// so busy frames turned into visible stop-and-go that programmatic scrolling
// never showed. The peek works without preventDefault, so the listener goes
// passive and input scrolls immediately. Transcript images also decode
// asynchronously now — full-resolution screenshots were decoding on the main
// thread the moment their 200px tile mounted, spiking frames as images
// resolved.
const WHEEL_PEEK_BEFORE = 'y.preventDefault(),d(),l(JVe(r+y.deltaX)),f()};s.addEventListener("wheel",h,{passive:!1})';
const WHEEL_PEEK_AFTER = 'd(),l(JVe(r+y.deltaX)),f()};s.addEventListener("wheel",h,{passive:!0})';
const IMG_FADE_BEFORE = 'p.jsx("img",{alt:Ce,className:Ie,"data-fade":!0,"data-loaded":Pe,draggable:!1,onError:je,onLoad:Le,ref:V,src:A.src,style:oe.style},b)';
const IMG_FADE_AFTER = 'p.jsx("img",{alt:Ce,className:Ie,crossOrigin:A.src&&A.src.startsWith("sand-media:")?"anonymous":void 0,"data-fade":!0,"data-loaded":Pe,decoding:"async",draggable:!1,onError:je,onLoad:Le,ref:V,src:A.src&&A.src.startsWith("sand-media:")?A.src+"?w="+(self.__sandVariantWidth?self.__sandVariantWidth(A.src,window.devicePixelRatio>1.5?1120:560):(window.devicePixelRatio>1.5?1120:560)):A.src,style:oe.style},b)';
const IMG_THUMB_BEFORE = 'p.jsx("img",{alt:oe,"aria-hidden":ve,className:ge,"data-variant":"thumb",draggable:!1,src:A.src,style:ye.style})';
const IMG_THUMB_AFTER = 'p.jsx("img",{alt:oe,"aria-hidden":ve,className:ge,crossOrigin:A.src&&A.src.startsWith("sand-media:")?"anonymous":void 0,"data-variant":"thumb",decoding:"async",draggable:!1,src:A.src&&A.src.startsWith("sand-media:")?A.src+"?w="+(self.__sandVariantWidth?self.__sandVariantWidth(A.src,window.devicePixelRatio>1.5?560:440):(window.devicePixelRatio>1.5?560:440)):A.src,style:ye.style})';

// Renderer-side media metadata: the coordinator backfill only reaches rows in
// the local routed store, so box-agent transcripts (served over the Cursor
// RPC) would square-fallback forever. Instead the renderer itself remembers
// every image's and video's natural size the first time it loads (a capture-
// phase load listener sees them all) plus a ~24px blur-up thumbnail, persisted
// in localStorage keyed by the content-hashed file path - immutable content,
// so entries can never go stale. Later mounts consult the store before the
// media resolves: exact-size frames from first paint and a blurred preview
// instead of the grey skeleton. Size metadata stays images/videos only - text
// reflows with viewport width and must never be height-cached.
const MEDIA_META_HELPER = ';(()=>{try{var K="sandMediaMeta.v1",m=null,t=0;'
  + 'var load=function(){if(m)return m;m=new Map();try{var raw=localStorage.getItem(K);if(raw){var o=JSON.parse(raw);for(var k in o){var v=o[k];Array.isArray(v)&&v.length>=2&&m.set(k,v)}}}catch(_){}return m};'
  + 'var save=function(){t||(t=setTimeout(function(){t=0;try{var o={},total=0,keys=Array.from(m.keys());for(var i=Math.max(0,keys.length-2400);i<keys.length;i++){var k=keys[i],v=m.get(k);total+=k.length+(v[2]?v[2].length:8);if(total>3500000)break;o[k]=v}localStorage.setItem(K,JSON.stringify(o))}catch(_){}},900))};'
  + 'var norm=function(u){if(typeof u!="string"||!u)return"";if(u.indexOf("sand-media:")===0){try{var pn=new URL(u).pathname.replace(/^\\/+/,"");return decodeURIComponent(pn)}catch(_){return u.split("?")[0]}}var q=u.indexOf("?");return q<0?u:u.slice(0,q)};'
  + 'var thumbOf=function(el,w,h,tg,q){try{var sc=Math.max(1,Math.max(w,h)/(tg||24)),cw=Math.max(1,Math.round(w/sc)),ch=Math.max(1,Math.round(h/sc)),c=document.createElement("canvas");c.width=cw;c.height=ch;c.getContext("2d").drawImage(el,0,0,cw,ch);return c.toDataURL("image/jpeg",q||.5)}catch(_){return null}};'
  + 'window.__sandMediaMeta={get:function(k){var map=load(),n=norm(k),v=map.get(n);if(!v)return null;map.delete(n);map.set(n,v);return{w:v[0],h:v[1],thumb:v[2]||null,bw:v[3]||null}},setBox:function(k,bw){if(!(bw>8))return;var map=load(),n=norm(k),v=map.get(n);if(!v)return;var r=Math.round(bw);if(v[3]===r)return;v[3]=r;save()},set:function(k,w,h,thumb){if(!(w>0&&h>0))return;var n=norm(k);if(!n)return;var map=load(),prev=map.get(n),keep=thumb||(prev&&prev[2])||null;if(prev&&prev[0]===w&&prev[1]===h&&prev[2]===keep)return;var bw=prev&&prev[3];map.delete(n);var nv=keep?[w,h,keep]:[w,h];bw>8&&(nv[3]=bw);map.set(n,nv);save()},clearAgent:function(id){if(!id)return 0;var map=load(),n=0,needle="/agents/"+id+"/";map.forEach(function(v,k){if(k.indexOf(needle)>=0){map.delete(k);n++}});if(n)save();return n},clearKey:function(k){var map=load(),n=norm(k);if(map.delete(n)){save();return 1}return 0}};'
  // Zero-jump estimator feed: the chat-plane engine estimates unmounted rows
  // via per-card placeholder constants (attachment cards say 60) while the
  // real tiles are height-locked to min(200, naturalH). This helper gives the
  // patched iAn() the exact number for cached media entries - same store, same
  // formula as the rendered tile - so estimate == measured and rows below
  // never shove. Returns null (keep stock estimate) for text, non-media files,
  // and never-loaded media: first-load behavior is deliberately unchanged.
  + 'var mediaUrlOf=function(en){try{return!en?null:en.kind==="user-attachment"?(en.file_path||null):en.kind==="send-message"&&en.message&&en.message.type==="attachment"?(en.message.url||null):null}catch(_){return null}};'
  // Single image: the rendered box is h=min(200,naturalH) with the width
  // capped at 560; when that cap binds the height follows the aspect (the
  // y7n clamp-box fix), so the estimate must do the same or rows settle.
  + 'window.__sandMediaEstimate=function(en){try{var u=mediaUrlOf(en);if(!u)return null;var v=window.__sandMediaMeta.get(u);if(!(v&&v.h>0&&v.w>0))return null;return Math.min(200,v.h)}catch(_){return null}};'
  // Skeleton-phase capture: the loading placeholder IS the media frame in
  // its pre-load state, and it is gone by the time anyone can hover - so the
  // frame rect is snapshotted at mount while the image is still unresolved
  // (MutationObserver fires pre-paint), and the load listener records the
  // post-load rect one frame later. Session-scoped, keyed like the media
  // store; the inspector shows skeleton-vs-final only when a skeleton phase
  // was actually observed.
  + 'var SKEL=new Map();'
  + 'window.__sandSkel={get:function(k){return SKEL.get(norm(k))||null},size:function(){return SKEL.size},each:function(fn){SKEL.forEach(function(v,k){try{fn(k,v)}catch(_){}})}};'
  + 'var skelFrameOf=function(img){return img.closest&&(img.closest(".sand-attachment__image-frame,.sand-image-row__tile")||img)||img};'
  // Diagnostics gate: skeleton capture (and the lint watcher in the debug
  // helper) run only when sandLayoutLint is armed - off by default in the
  // shipped build; toggling the media debugger arms it once, and it then
  // stays armed across relaunches until explicitly disabled. Feature stores
  // (dims, text heights) are NOT gated - the renderer and estimator eat them.
  + 'var skelNote=function(img){try{if(localStorage.getItem("sandLayoutLint")!=="1")return;if(!img||img.tagName!=="IMG")return;var src=img.currentSrc||img.src;if(!src||src.indexOf("data:")===0)return;if(img.complete&&img.naturalWidth>0)return;var r=skelFrameOf(img).getBoundingClientRect();if(!(r.width>4&&r.height>4))return;var k=norm(src);if(!k||SKEL.has(k))return;if(SKEL.size>400)SKEL.delete(SKEL.keys().next().value);SKEL.set(k,{sw:Math.round(r.width),sh:Math.round(r.height),at:Date.now()})}catch(_){}};'
  // Tag gallery tiles whose source cannot fill the cell so CSS letterboxes
  // them instead of upscaling. Class-only: no geometry is written, so row
  // heights (and the estimator's agreement with them) never move.
  + 'var fitTag=function(img){try{if(!img||img.tagName!=="IMG"||!img.naturalWidth)return;var box=img.closest&&(img.closest(".sand-image-row__tile")||img.closest(".sand-attachment__image-frame"));if(!box)return;var r=box.getBoundingClientRect();if(!(r.width>4&&r.height>4))return;'
  // Contain when the source cannot fill the box (upscale/blur) OR when the
  // box shape differs from the picture's (cover would crop it away) - both
  // are fixed without touching a single dimension of the layout.
  // Only one condition matters: a source too small for its box would be
  // scaled UP (blur). Everything else keeps the app's own fit - gallery cells
  // cover-fill by design (locked rule) and single frames already letterbox
  // themselves, so neither is second-guessed here.
  + 'var small=img.naturalWidth<r.width-1||img.naturalHeight<r.height-1;'
  + 'img.classList.toggle("sand-fit-natural",small);'
  + 'try{window.__sandMediaMeta.setBox(img.currentSrc||img.src,r.width)}catch(_){}}catch(_){}};'
  // Variant ladder: ask for the pixels the box actually needs at this screen's
  // density, rounded up to a fixed rung so the on-disk variant cache keeps
  // hitting. Every image used to request a flat 1120 regardless of its box -
  // a 186px tile needs 372 at 2x, so it was decoding ~9x the pixels it shows.
  // Sharpness is unchanged (1120 already covered every box); this is memory.
  // Falls back to the old constant when the element has no layout yet, so a
  // first paint is never worse than before.
  + 'var LADDER=[128,192,256,384,512,768,1024,1120,1536,2048];'
  // The URL is known at render time but the element is not, and measuring
  // after mount would mean a second fetch - so the box width each image was
  // last drawn at is remembered in the media store (recorded by fitTag on
  // mount) and reused on every later mount, including after a relaunch. The
  // first sighting of an image still uses the old constant.
  + 'window.__sandVariantWidth=function(url,fallback){try{if(!url||url.indexOf("sand-media:")!==0)return fallback;var v=window.__sandMediaMeta.get(url);var bw=v&&v.bw;if(!(bw>8))return fallback;var want=Math.ceil(bw*(window.devicePixelRatio||1));for(var i=0;i<LADDER.length;i++)if(LADDER[i]>=want)return LADDER[i];return 2048}catch(_){return fallback}};'
  + 'var fitSweep=function(){try{document.querySelectorAll(".sand-virtual-transcript .sand-image-row__tile img,.sand-virtual-transcript .sand-attachment__image-frame img").forEach(fitTag)}catch(_){}};'
  + 'document.addEventListener("load",function(ev){ev.target&&ev.target.tagName==="IMG"&&fitTag(ev.target)},!0);setInterval(fitSweep,1200);'
  + 'var skelMo=new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var ad=ms[i].addedNodes;for(var j=0;j<ad.length;j++){var n=ad[j];if(!n||n.nodeType!==1)continue;if(n.tagName==="IMG")skelNote(n);else if(n.querySelectorAll)n.querySelectorAll("img").forEach(skelNote)}}});'
  + 'var skelCur=null;var skelArm=function(){var sc=document.querySelector(".sand-virtual-transcript");if(sc&&sc!==skelCur){skelCur=sc;skelMo.disconnect();skelMo.observe(sc,{childList:true,subtree:true})}};setInterval(skelArm,1500);skelArm();'
  + 'var rec=function(ev){var el=ev.target;try{if(el&&el.tagName==="IMG"&&el.naturalWidth>0){var src=el.currentSrc||el.src;if(src&&src.indexOf("data:")!==0){window.__sandMediaMeta.set(src,el.naturalWidth,el.naturalHeight,null);var sk=SKEL.get(norm(src));if(sk&&sk.fw==null)requestAnimationFrame(function(){try{var fr=skelFrameOf(el).getBoundingClientRect();if(fr.width>4){sk.fw=Math.round(fr.width);sk.fh=Math.round(fr.height)}}catch(_){}})}}else if(el&&el.tagName==="VIDEO"&&el.videoWidth>0){var vs=el.currentSrc||el.src;if(vs){window.__sandMediaMeta.set(vs,el.videoWidth,el.videoHeight,null);var pv=window.__sandMediaMeta.get(vs);if((!pv||!pv.thumb)&&vs.indexOf("sand-media:")===0){try{el.currentTime=Math.max(el.currentTime,.05)}catch(_){}}}}}catch(_){}};'
  + 'var recFrame=function(ev){var el=ev.target;try{if(el&&el.tagName==="VIDEO"&&el.videoWidth>0){var vs=el.currentSrc||el.src;if(vs)window.__sandMediaMeta.set(vs,el.videoWidth,el.videoHeight,thumbOf(el,el.videoWidth,el.videoHeight,320,.6))}}catch(_){}};'
  + 'document.addEventListener("load",rec,!0);document.addEventListener("loadedmetadata",rec,!0);document.addEventListener("loadeddata",recFrame,!0);document.addEventListener("seeked",recFrame,!0);'
  // Width-keyed text-height cache (user-approved amendment of the "never
  // cache text heights" rule: never use a height measured under DIFFERENT
  // conditions). Row heights are recorded together with the transcript width
  // and root font size that produced them; the estimator replays a height
  // only on an exact condition match, so a resized window or zoom change is
  // a key miss and the row is measured live exactly as before. The cache
  // only replaces the GUESS - the engine still measures every mounted row
  // and corrects, so a stale entry degrades to today's behavior, never to a
  // wrong layout. Keys mirror the app's own row identity (nPe): message
  // entries with a clientNonce key as nonce:<clientNonce>, everything else
  // by entry id. Pending/streaming rows are never recorded or replayed.
  + 'var TH_K="sandTextHeights.v2",thm=null,tht=0;'
  + 'var thLoad=function(){if(thm)return thm;thm=new Map();try{var raw=localStorage.getItem(TH_K);if(raw){var o=JSON.parse(raw);for(var k in o){var v=o[k];typeof v==="number"&&v>0&&thm.set(k,v)}}}catch(_){}return thm};'
  + 'var thSave=function(){tht||(tht=setTimeout(function(){tht=0;try{var o={},keys=Array.from(thm.keys());for(var i=Math.max(0,keys.length-6000);i<keys.length;i++)o[keys[i]]=thm.get(keys[i]);localStorage.setItem(TH_K,JSON.stringify(o))}catch(_){}},1200))};'
  + 'var thEnv=null,thEnvAt=0;var thCond=function(){var now=Date.now();if(thEnv&&now-thEnvAt<700)return thEnv;var sc=document.querySelector(".sand-virtual-transcript");if(!sc)return null;thEnvAt=now;thEnv="w"+Math.round(sc.clientWidth)+"f"+parseFloat(getComputedStyle(document.documentElement).fontSize||"16");return thEnv};'
  + 'var thRowKey=function(en){if(!en)return null;return en.kind==="message"&&en.clientNonce!=null?"nonce:"+en.clientNonce:(typeof en.id==="string"?en.id:null)};'
  + 'window.__sandTextHeights={'
  + 'est:function(en){try{if(!en||en.isStreaming===true||en.streaming===true)return null;var ag=self.__sandCurrentAgent&&self.__sandCurrentAgent();var c=thCond();var rk=thRowKey(en);if(!ag||!c||!rk)return null;var v=thLoad().get(ag+"|"+rk+"|"+c);return typeof v==="number"&&v>0?v:null}catch(_){return null}},'
  + 'estRow:function(rowKey){try{var ag=self.__sandCurrentAgent&&self.__sandCurrentAgent();var c=thCond();if(!ag||!c||!rowKey)return null;var v=thLoad().get(ag+"|"+rowKey+"|"+c);return typeof v==="number"&&v>0?v:null}catch(_){return null}},'
  + 'size:function(){return thLoad().size},'
  + 'clearAgent:function(id){if(!id)return 0;var m=thLoad(),n=0,pre=id+"|";m.forEach(function(v,k){if(k.indexOf(pre)===0){m.delete(k);n++}});if(n)thSave();return n}};'
  + 'var thSweep=function(){try{var sc=document.querySelector(".sand-virtual-transcript");if(!sc)return;var ag=self.__sandCurrentAgent&&self.__sandCurrentAgent();var c=thCond();if(!ag||!c)return;var m=thLoad();var dirty=false;sc.querySelectorAll("[data-row-key]").forEach(function(row){var k=row.getAttribute("data-row-key");if(!k||k==="unread-divider")return;var col=k.indexOf(":");if(col>=0&&k.slice(0,5)!=="nonce"&&k.slice(col)!==":attachment-group")return;if(row.hasAttribute("data-pending"))return;'
  // Never record a height while the row is still settling: a media row that
  // has not decoded its pictures yet is showing a placeholder height, and
  // caching that value would make the next launch replay a number the row
  // is about to abandon - worse than having no cache at all.
  + 'var ims=row.querySelectorAll("img");if(ims.length){for(var q=0;q<ims.length;q++)if(!ims[q].complete||ims[q].naturalWidth===0)return}else if(row.querySelector(".sand-image-row,.sand-attachment__image-frame"))return;'
  + 'var h=row.getBoundingClientRect().height;if(!(h>8))return;var body=Math.round((col>=0&&k.slice(col)===":attachment-group"?h:h-4)*2)/2;var key=ag+"|"+k+"|"+c;if(m.get(key)!==body){m.delete(key);m.set(key,body);dirty=true}});dirty&&thSave()}catch(_){}};'
  + 'setInterval(thSweep,900);setTimeout(thSweep,2500)'
  + '}catch(_){}})();\n';

// Jump-to-newest pill. 0.18 carries the pin/release reducer but renders no
// pill; rather than surgery on the minified virtualizer JSX, this overlays a
// floating button driven purely by the scroll container's geometry. A single
// capture-phase scroll listener (scroll doesn't bubble but capture sees it),
// a resize listener, and a low-frequency interval (catches chat switches and
// streaming growth with no scroll event) keep it placed and toggled.
const JUMP_PILL_HELPER = ';(()=>{try{'
  + 'var pill=document.createElement("button");pill.type="button";pill.className="sand-jump-newest";pill.hidden=true;pill.setAttribute("aria-label","Scroll to bottom");pill.title="Scroll to bottom";'
  + "pill.innerHTML='<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 5v13\"/><path d=\"M6 12l6 6 6-6\"/></svg>';"
  + 'document.body.appendChild(pill);var vp=null,TH=200;'
  + 'var nativePill=function(){var els=document.querySelectorAll("button,[role=button]");for(var i=0;i<els.length;i++){var b=els[i];if(/new message/i.test(b.textContent||"")&&b.offsetHeight>0&&b.offsetHeight<80)return b}return null};'
  // The transcript stays scrollable underneath an overlay, so geometry alone
  // kept the pill on screen over the fullscreen computer view and over modals.
  // Reuse the surface list the bundle already uses for the same question.
  + 'var SURFACES=\'[data-dune-surface="overlay"],[role="dialog"],[role="alertdialog"],.sand-command-palette,.sand-computer-fullscreen\';'
  + 'var covered=function(){var n=document.querySelectorAll(SURFACES);for(var i=0;i<n.length;i++){var e=n[i];if(e.offsetHeight>0&&e.offsetWidth>0)return true}return false};'
  // Sits centered over the transcript, floating just above the composer like
  // official 0.29 - never overlapping the input. Yields to the app's own
  // "N new messages" pill whenever that is showing.
  + 'var place=function(){var el=document.querySelector(".sand-virtual-transcript");vp=el;if(!el||covered()||nativePill()||el.scrollHeight-el.clientHeight<TH||el.scrollHeight-el.clientHeight-el.scrollTop<TH){pill.hidden=true;return}var r=el.getBoundingClientRect();var comp=document.querySelector(".sand-prompt-field");var cr=comp?comp.getBoundingClientRect():null;var top=cr?cr.top-58:r.bottom-58;pill.style.left=(r.left+r.width/2)+"px";pill.style.top=top+"px";pill.hidden=false};'
  // The snap loop must not fight the engine's own correction writes: bail as
  // soon as we are inside the engine's 4px bottom-pin threshold so exactly one
  // system finishes the landing.
  + 'pill.addEventListener("click",function(){if(!vp)return;var el=vp,n=0;var snap=function(){if(el.scrollHeight-el.clientHeight-el.scrollTop<2)return;el.scrollTop=el.scrollHeight;if(++n<8)requestAnimationFrame(snap)};snap()});'
  // Official 0.29 behavior for the app's own new-messages pill: clicking it
  // jumps to the first unread (the New divider), stepping the virtualizer
  // toward the bottom until the divider mounts; the dismiss X keeps its
  // native behavior.
  + 'var jumpToUnread=function(){var el=document.querySelector(".sand-virtual-transcript");if(!el)return;var steps=0;var hunt=function(){var d=document.querySelector(".sand-unread-divider");if(d){d.scrollIntoView({block:"center"});return}var bottom=el.scrollHeight-el.clientHeight;if(el.scrollTop>=bottom-4||steps++>60){el.scrollTop=el.scrollHeight;return}el.scrollTop=Math.min(bottom,el.scrollTop+el.clientHeight*0.85);requestAnimationFrame(hunt)};hunt()};'
  + 'document.addEventListener("click",function(ev){var np=nativePill();if(!np)return;var t=ev.target;if(!(t&&np.contains(t)))return;if(t.closest&&t.closest("[aria-label*=ismiss],[aria-label*=lose]"))return;var tag=(t.tagName||"").toLowerCase();if(tag==="svg"||tag==="path"){var lbl=(t.closest("button,[role=button]")||{}).getAttribute&&(t.closest("button,[role=button]")||{}).getAttribute("aria-label")||"";if(/dismiss|close/i.test(lbl))return}ev.preventDefault();ev.stopPropagation();jumpToUnread()},true);'
  + 'document.addEventListener("scroll",function(e){var t=e.target;if(t&&t.classList&&t.classList.contains("sand-virtual-transcript"))place()},true);'
  + 'window.addEventListener("resize",place);setInterval(place,400)}catch(_){}})();\n';

// Message deep-link consumer: window.desktop.onDeepLink delivers parsed
// links from main; for route "message" this opens the agent's chat and
// sweeps the virtualized transcript until the row with that entry id
// mounts, then centers and briefly highlights it.
const DEEPLINK_MSG_HELPER = ';(()=>{try{'
  + 'var openMessage=function(agentId,messageId,indexHint){var tries=0;var sel=function(id){var q=JSON.stringify(String(id));return "[data-entry-id="+q+"],[data-row-key="+q+"]"};var found=function(el){var n=0;var center=function(){el.scrollIntoView({block:"center"});if(++n<6)setTimeout(center,350)};center();el.style.transition="box-shadow .3s";el.style.boxShadow="0 0 0 3px #1d9bf0";setTimeout(function(){el.style.boxShadow=""},5000)};var jump=function(idx){var sc=document.querySelector(".sand-virtual-transcript");if(!sc)return;var lo=0,hi=sc.scrollHeight,it=0;var step=function(){var el=document.querySelector(sel(messageId));if(el){found(el);return}var rows=Array.prototype.slice.call(document.querySelectorAll("[data-index]")).map(function(r){return parseInt(r.getAttribute("data-index"),10)}).filter(isFinite);if(rows.length){var mn=Math.min.apply(null,rows),mx=Math.max.apply(null,rows);if(idx<mn)hi=sc.scrollTop;else if(idx>mx)lo=sc.scrollTop;sc.scrollTop=(lo+hi)/2}if(++it<26)setTimeout(step,280);else hunt()};sc.scrollTop=sc.scrollHeight/2;setTimeout(step,450)};var openChat=function(){var row=document.querySelector(".sand-agent-item[data-agent-id="+JSON.stringify(String(agentId))+"]");if(!row){if(++tries<20)setTimeout(openChat,400);return}row.click();'
  // Some rows are keyed by their send nonce rather than the entry id (and
  // grouped rows key by a sibling), so after a successful engine navigate the
  // target key may not exist in the DOM at all. The engine still centered the
  // right row - fall back to ringing the row at the viewport center.
  + 'var glow=function(){var w=0;var wait=function(){var el2=document.querySelector(sel(messageId));if(!el2&&w>5){var mid=document.elementFromPoint(innerWidth/2,innerHeight/2);el2=mid&&mid.closest?mid.closest("[data-row-key]"):null}if(el2){el2.style.transition="box-shadow .3s";el2.style.boxShadow="0 0 0 3px #1d9bf0";setTimeout(function(){el2.style.boxShadow=""},5000);return}if(++w<24)setTimeout(wait,250)};wait()};'
  // The transcript is windowed: the engine can only navigate to rows whose
  // entries are loaded. Try the engine teleport first (smooth centered jump +
  // glow); when the target predates the loaded window, fast-rewind a few
  // screens per tick - upward scroll is what makes the app pull older pages -
  // and retry the teleport after each step so it snaps the moment the entry
  // enters the window. DOM sweep remains the last-resort fallback.
  // Jump-load: stream older pages in place through the store's own
  // loadOlder() (no scrolling, viewport stays put) and teleport the moment
  // the target enters the window; scroll-rewind only if the store global is
  // unavailable, DOM sweep as the final fallback.
  + 'var go=function(n){var ok=false;try{ok=self.__sandNavToRow&&self.__sandNavToRow(String(messageId))===true}catch(_){}if(ok){glow();return}var ts=self.__sandTranscript;if(ts&&ts.loadOlder){try{ts.loadOlder(String(agentId))}catch(_){}}else{var sc=document.querySelector(".sand-virtual-transcript");if(sc)sc.scrollTop=Math.max(0,sc.scrollTop-sc.clientHeight*3)}if(n<90){setTimeout(function(){go(n+1)},250);return}typeof indexHint==="number"&&isFinite(indexHint)?jump(indexHint):hunt()};setTimeout(function(){go(0)},900)};'
  + 'var steps=0;var hunt=function(){var sc=document.querySelector(".sand-virtual-transcript");if(!sc)return;var el=document.querySelector("[data-entry-id=\'"+messageId+"\']");if(el){el.scrollIntoView({block:"center"});el.style.transition="box-shadow .3s";el.style.boxShadow="0 0 0 3px #1d9bf0";setTimeout(function(){el.style.boxShadow=""},4000);return}if(steps===0)sc.scrollTop=0;else{var before=sc.scrollTop;sc.scrollTop=Math.min(sc.scrollHeight,before+sc.clientHeight*0.95);if(sc.scrollTop>=sc.scrollHeight-sc.clientHeight-4&&steps>2)return}if(++steps<120)setTimeout(hunt,320)};openChat()};'
  + 'self.__sandOpenMessage=openMessage;'
  + 'var arm=function(){if(window.desktop&&window.desktop.onDeepLink){window.desktop.onDeepLink(function(l){try{if(l&&l.route==="message"&&l.agentId&&l.messageId)openMessage(l.agentId,l.messageId,l.indexHint)}catch(_){}});var rdy=0;var ready=function(){rdy++;try{var pr=window.desktop.deepLinksReady&&window.desktop.deepLinksReady();if(pr&&pr.catch)pr.catch(function(){})}catch(_){}rdy<20&&setTimeout(ready,3000)};ready();return true}return false};'
  + 'arm()||setTimeout(arm,2000)'
  + '}catch(_){}})();\n';

// Multi-select mode: entered from the message hover menu ("Select messages"),
// exited with Esc/Cancel. Selection state lives in a JS store, never the DOM -
// the transcript is virtualized and rows unmount constantly. Selection chrome
// (checkbox chips + tint) is an overlay in its own fixed layer repainted per
// frame, same idiom as the media debugger; the app's React tree is never
// touched. Entry ids come from data-entry-id / data-entry-ids (groups) or,
// for plain entry rows, from data-row-key which IS the entry id (verified
// live: entry rows key by id, group rows suffix ":attachment-group" etc).
// Share/Bookmark feature-detect window.desktop.collections so this merges
// ahead of the Collections page; Delete feature-detects the PR-A bridge.
const SELECT_MODE_HELPER = ';(()=>{try{'
  + 'var ADDR=/^t(?:\\d+u(?:a\\d+)?|(?:\\d+|b)[as]\\d+)$/;'
  // Device-local tombstones: the host-side delete only exists where OUR host
  // owns the agent store (local runtimes). Agents living on Cursor's remote
  // box answer through Cursor's own in-box gateway, which we can never extend
  // - so for those, delete falls back to hiding the entries in the renderer's
  // row projection. Persisted per agent in localStorage; the row builder
  // (npt) filters through this before grouping.
  + 'var TK="sandTombstones.v1";var tcache=null;var tload=function(){if(tcache)return tcache;try{tcache=JSON.parse(localStorage.getItem(TK)||"{}")}catch(_){tcache={}}return tcache};'
  + 'var tsave=function(){try{localStorage.setItem(TK,JSON.stringify(tcache||{}))}catch(_){}};'
  + 'var tsets={};var tset=function(ag){if(!ag)return null;if(!tsets[ag]){var o=tload();tsets[ag]=new Set(o[ag]||[])}return tsets[ag]};'
  + 'window.__sandTombstones={'
  + 'add:function(ag,ids){if(!ag||!ids||!ids.length)return;var o=tload();var s=tset(ag);ids.forEach(function(i){s.add(i)});o[ag]=Array.from(s);tsave()},'
  + 'clearAgent:function(ag){var o=tload();delete o[ag];delete tsets[ag];tsave()},'
  + 'size:function(){var o=tload();var n=0;for(var k in o)n+=o[k].length;return n},'
  + 'filter:function(list){try{var ag=self.__sandCurrentAgent&&self.__sandCurrentAgent();var s=tset(ag);if(!s||!s.size)return list;return list.filter(function(en){return!(en&&s.has(en.id))})}catch(_){return list}}};'
  + 'var st={on:false,ids:new Set(),anchor:null};'
  + 'var css=document.createElement("style");css.textContent='
  + '".sand-sel-layer{position:fixed;inset:0;pointer-events:none;z-index:9998}"'
  + '+".sand-sel-chip{position:absolute;width:20px;height:20px;border-radius:50%;border:2px solid rgba(127,127,127,.75);background:rgba(255,255,255,.92);box-sizing:border-box}"'
  + '+".sand-sel-chip.on{background:#1d9bf0;border-color:#1d9bf0}"'
  + '+".sand-sel-chip.on::after{content:\\"\\";position:absolute;left:5px;top:2px;width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}"'
  + '+".sand-sel-tint{position:absolute;background:rgba(29,155,240,.10);border-radius:10px}"'
  + '+".sand-sel-bar{position:fixed;z-index:10001;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;background:#fff;color:#222;border:1px solid rgba(0,0,0,.14);box-shadow:0 6px 22px rgba(0,0,0,.16);border-radius:12px;padding:8px 14px;font:500 13px system-ui}"'
  + '+"html[data-theme*=dark] .sand-sel-bar{background:#26262b;color:#eee;border-color:rgba(255,255,255,.14)}"'
  + '+".sand-sel-bar button{font:600 12px system-ui;border:1px solid rgba(127,127,127,.4);background:transparent;border-radius:8px;padding:5px 11px;cursor:pointer;color:inherit}"'
  + '+".sand-sel-bar button.sand-sel-danger{color:#d34b3e;border-color:#d34b3e}"'
  + '+".sand-sel-bar button:disabled{opacity:.4;cursor:default}"'
  // display:flex beats the [hidden] attribute's UA default - without this the
  // bar never actually hides (it once stuck showing the tombstone message
  // across chats until relaunch).
  + '+".sand-sel-bar[hidden]{display:none}";'
  + 'document.head.appendChild(css);'
  + 'var layer=document.createElement("div");layer.className="sand-sel-layer";layer.hidden=true;document.body.appendChild(layer);'
  + 'var bar=document.createElement("div");bar.className="sand-sel-bar";bar.hidden=true;document.body.appendChild(bar);'
  + 'var idsOf=function(row){if(!row)return[];var multi=row.getAttribute("data-entry-ids");if(multi)return multi.split(" ").filter(Boolean);var one=row.getAttribute("data-entry-id");if(one)return[one];var key=row.getAttribute("data-row-key")||"";return ADDR.test(key)?[key]:[]};'
  + 'var rows=function(){var sc=document.querySelector(".sand-virtual-transcript");return sc?Array.prototype.slice.call(sc.querySelectorAll("[data-row-key]")):[]};'
  + 'var agentIdNow=function(){try{var a=self.__sandCurrentAgent&&self.__sandCurrentAgent();if(a)return a}catch(_){}var el=document.querySelector(".sand-agent-item[aria-pressed=true]");return el?el.getAttribute("data-agent-id")||"":""};'
  + 'var raf=0;var paint=function(){raf=0;if(!st.on){layer.hidden=true;return}layer.hidden=false;layer.textContent="";var sc=document.querySelector(".sand-virtual-transcript");if(!sc)return;var vr=sc.getBoundingClientRect();rows().forEach(function(row){var ids=idsOf(row);if(!ids.length)return;var r=row.getBoundingClientRect();if(r.bottom<vr.top||r.top>vr.bottom||r.height<8)return;var on=ids.every(function(i){return st.ids.has(i)});if(on){var t=document.createElement("div");t.className="sand-sel-tint";t.style.left=(vr.left+4)+"px";t.style.top=r.top+"px";t.style.width=(vr.width-8)+"px";t.style.height=r.height+"px";layer.appendChild(t)}var c=document.createElement("div");c.className="sand-sel-chip"+(on?" on":"");c.style.left=(vr.left+10)+"px";c.style.top=(r.top+Math.max(4,r.height/2-10))+"px";layer.appendChild(c)})};'
  + 'var queue=function(){raf||(raf=requestAnimationFrame(paint))};'
  + 'var flash=null;var renderBar=function(msg){if(!st.on){bar.hidden=true;return}bar.hidden=false;bar.textContent="";var n=st.ids.size;var span=document.createElement("span");span.textContent=msg||(n+" selected");bar.appendChild(span);if(msg)return;var mk=function(label,fn,cls){var b=document.createElement("button");b.textContent=label;cls&&b.classList.add(cls);b.addEventListener("click",function(ev){ev.stopPropagation();fn()});bar.appendChild(b);return b};'
  + 'var col=window.desktop&&window.desktop.collections;'
  + 'if(col&&col.addMessages){mk("Share to Collection\\u2026",function(){picker()});mk("Bookmark",function(){act("bookmark")})}'
  + 'var del=window.desktop&&window.desktop.agent&&window.desktop.agent.deleteTranscriptEntries;'
  + 'var db=mk("Delete",function(){confirmDelete()},"sand-sel-danger");if(!del||!n)db.disabled=true;'
  + 'mk("Cancel",function(){api.exit()})};'
  + 'var confirmDelete=function(){var n=st.ids.size;bar.textContent="";var span=document.createElement("span");span.textContent="Delete "+n+" message"+(n===1?"":"s")+" from this device? The agent\\u2019s own memory keeps them.";bar.appendChild(span);var ok=document.createElement("button");ok.textContent="Delete";ok.className="sand-sel-danger";ok.addEventListener("click",function(ev){ev.stopPropagation();doDelete()});bar.appendChild(ok);var back=document.createElement("button");back.textContent="Back";back.addEventListener("click",function(ev){ev.stopPropagation();renderBar()});bar.appendChild(back)};'
  + 'var bounce=function(ag){try{var rows=document.querySelectorAll(".sand-agent-item[data-agent-id]");var cur=null,other=null;rows.forEach(function(r){var id=r.getAttribute("data-agent-id");if(id===ag)cur=r;else if(!other)other=r});if(cur&&other){other.click();setTimeout(function(){cur.click()},400)}}catch(_){}};'
  + 'var doDelete=function(){var ag=agentIdNow();if(!ag){renderBar("No active agent detected");setTimeout(function(){renderBar()},2500);return}var ids=Array.from(st.ids);renderBar("Deleting\\u2026");window.desktop.agent.deleteTranscriptEntries({agentId:ag,entryIds:ids}).then(function(res){var del=(res&&res.deleted)||[];var blocked=(res&&res.blocked)||[];del.forEach(function(i){st.ids.delete(i)});if(blocked.length){renderBar(del.length+" deleted \\u00b7 "+blocked.length+" blocked ("+blocked.map(function(b){return b.reason}).filter(function(v,i,a){return a.indexOf(v)===i}).join(", ")+")");setTimeout(function(){st.ids.size?renderBar():api.exit()},3200)}else{api.exit()}queue()}).catch(function(_e){window.__sandTombstones.add(ag,ids);renderBar("Hidden on this device (remote agent \\u2014 the server copy is unchanged)");setTimeout(function(){api.exit();bounce(ag)},1600)})};'
  + 'var send=function(extra,label){var ag=agentIdNow();var ids=Array.from(st.ids);var col=window.desktop&&window.desktop.collections;if(!col||!col.addMessages)return;renderBar(label);var req={agentId:ag,entryIds:ids};for(var k in extra)req[k]=extra[k];col.addMessages(req).then(function(){api.exit()}).catch(function(e){renderBar("Failed: "+(e&&e.message||e));setTimeout(function(){renderBar()},3000)})};'
  + 'var act=function(kind){send({target:"bookmarks"},"Bookmarking\\u2026")};'
  // Share picker: existing collections listed by name (Bookmarks included),
  // plus an inline "New collection" name field - no more silently minted
  // "Collection <date>" names.
  + 'var picker=function(){var col=window.desktop&&window.desktop.collections;if(!col||!col.list){send({},"Sharing\\u2026");return}bar.textContent="";var span=document.createElement("span");span.textContent="Add "+st.ids.size+" to\\u2026";bar.appendChild(span);var mkb=function(label,fn){var b=document.createElement("button");b.textContent=label;b.addEventListener("click",function(ev){ev.stopPropagation();fn()});bar.appendChild(b);return b};'
  + 'col.list().then(function(r){var cols=(r&&r.collections)||[];cols.slice(0,6).forEach(function(c){mkb(c.name+" ("+(c.count||0)+")",function(){send(c.id==="bookmarks"?{target:"bookmarks"}:{collectionId:c.id},"Sharing\\u2026")})});'
  + 'mkb("New collection\\u2026",function(){bar.textContent="";var lab=document.createElement("span");lab.textContent="Name:";bar.appendChild(lab);var inp=document.createElement("input");inp.type="text";inp.placeholder="Collection name";inp.style.cssText="font:500 13px system-ui;border:1px solid rgba(127,127,127,.4);border-radius:8px;padding:5px 9px;background:transparent;color:inherit;min-width:180px";inp.addEventListener("keydown",function(ev){ev.stopPropagation();if(ev.key==="Enter"&&inp.value.trim())send({name:inp.value.trim()},"Sharing\\u2026");if(ev.key==="Escape")renderBar()});bar.appendChild(inp);mkb("Create",function(){inp.value.trim()&&send({name:inp.value.trim()},"Sharing\\u2026")});mkb("Back",function(){picker()});inp.focus()});'
  + 'mkb("Back",function(){renderBar()})}).catch(function(){send({},"Sharing\\u2026")})};'
  + 'var onClick=function(ev){if(!st.on)return;if(bar.contains(ev.target))return;var sc=document.querySelector(".sand-virtual-transcript");if(!sc||!sc.contains(ev.target))return;ev.preventDefault();ev.stopPropagation();var row=ev.target&&ev.target.closest?ev.target.closest("[data-row-key]"):null;var ids=idsOf(row);if(!ids.length)return;var idx=row.getAttribute("data-index");if(ev.shiftKey&&st.anchor!=null&&idx!=null){var lo=Math.min(st.anchor,+idx),hi=Math.max(st.anchor,+idx);rows().forEach(function(r){var i=+r.getAttribute("data-index");if(i>=lo&&i<=hi)idsOf(r).forEach(function(x){st.ids.add(x)})})}else{var on=ids.every(function(i){return st.ids.has(i)});ids.forEach(function(i){on?st.ids.delete(i):st.ids.add(i)});if(idx!=null)st.anchor=+idx}renderBar();queue()};'
  + 'var onKey=function(ev){if(st.on&&ev.key==="Escape"){ev.preventDefault();ev.stopPropagation();api.exit()}};'
  // Cmd/Ctrl+Shift+A enters selection mode from anywhere in a chat - the
  // hover-menu item stays, this is the discoverable fast path.
  + 'document.addEventListener("keydown",function(ev){if((ev.metaKey||ev.ctrlKey)&&ev.shiftKey&&(ev.key==="A"||ev.key==="a")&&!st.on&&document.querySelector(".sand-virtual-transcript")){ev.preventDefault();api.enter()}},true);'
  + 'var iv=0;var mo=new MutationObserver(queue);'
  + 'var api={active:function(){return st.on},count:function(){return st.ids.size},'
  + 'enter:function(seed){if(st.on)return;st.on=true;st.ids=new Set();st.anchor=null;if(seed&&ADDR.test(String(seed)))st.ids.add(String(seed));var sc=document.querySelector(".sand-virtual-transcript");sc&&mo.observe(sc,{childList:true,subtree:true,attributes:true,attributeFilter:["style"]});iv=setInterval(queue,300);document.addEventListener("click",onClick,true);document.addEventListener("keydown",onKey,true);document.addEventListener("scroll",queue,true);renderBar();queue()},'
  + 'exit:function(){if(!st.on)return;st.on=false;st.ids.clear();mo.disconnect();clearInterval(iv);document.removeEventListener("click",onClick,true);document.removeEventListener("keydown",onKey,true);document.removeEventListener("scroll",queue,true);bar.hidden=true;layer.hidden=true;layer.textContent=""},'
  + 'toggle:function(id){st.ids.has(id)?st.ids.delete(id):st.ids.add(id);renderBar();queue()}};'
  + 'window.__sandSelect=api'
  + '}catch(_){}})();\n';

// Media/component inspector (runtime toggle, DevTools-style). Cmd/Ctrl+Shift+D
// cycles off -> INSPECTOR -> SWEEP -> off. Inspector is the default mode: one
// box + detail panel for the component under the mouse only - nothing pops up
// on its own (the old boot auto-restore is gone on purpose; the flag never
// re-enables across launches). Sweep is the old behavior: every mounted media
// frame at once, now covering gallery tiles and videos too. Everything paints
// in a separate fixed layer - React-owned nodes are never touched.
// Verdicts (media only, judged ONLY once dims are cached): green = rendered at
// natural aspect and scale, red = cropped or upscaled, dashed grey = can't
// judge yet. Corner dot: grey = no cache entry, blue = dims cached, dark blue
// = dims + poster thumb; spinner while loading. Non-media components (cards,
// prompts, text rows) get a neutral blue box + panel naming the row kind -
// they have no natural-size contract, so no health verdict.
const MEDIA_DEBUG_HELPER = ';(()=>{try{'
  + 'var K="sandMediaDebug",mode=0,iv=null;'
  + 'var layer=document.createElement("div");layer.style.cssText="position:fixed;inset:0;pointer-events:none;z-index:9999;display:none";'
  + 'var style=document.createElement("style");style.textContent=".smd-box{position:absolute;pointer-events:none;box-sizing:border-box}.smd-dot{position:absolute;width:10px;height:10px;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.85)}.smd-spin{border:2px solid #888;border-top-color:transparent;background:transparent!important;animation:smdspin .9s linear infinite}@keyframes smdspin{to{transform:rotate(360deg)}}.smd-tag{position:absolute;font:600 9px/1.5 -apple-system,sans-serif;background:rgba(0,0,0,.75);color:#fff;padding:0 5px;border-radius:4px;white-space:nowrap}.smd-panel{position:fixed;z-index:10002;pointer-events:none;font:500 11px/1.55 -apple-system,sans-serif;background:rgba(20,20,24,.92);color:#f2f2f2;border-radius:8px;padding:7px 10px;max-width:300px;box-shadow:0 4px 16px rgba(0,0,0,.35)}.smd-panel b{font-weight:700;color:#7fd0ff}.smd-mode{position:fixed;z-index:10002;pointer-events:none;right:14px;bottom:14px;font:700 10px/1 -apple-system,sans-serif;letter-spacing:.08em;background:rgba(20,20,24,.85);color:#9fe870;border-radius:6px;padding:5px 8px}";'
  + 'var keyOf=function(u){if(!u)return null;try{if(u.indexOf("sand-media:")===0){return decodeURIComponent(new URL(u).pathname.replace(/^\\/+/,""))}}catch(_){return u.split("?")[0]}return u.split("?")[0]};'
  + 'var kindOfRow=function(row){if(!row)return"unknown";var k=row.getAttribute("data-row-key")||"";var c=k.indexOf(":");if(c>=0)return k.slice(c+1).replace(/^[0-9a-f-]{20,}/,"nonce");return/^t/.test(k)?((/u(a\\d+)?$/.test(k)?"user message":/s\\d+$/.test(k)?"send-message":"agent message")):k||"row"};'
  + 'var mediaInfo=function(f){var el=f.matches&&f.matches("img,video")?f:f.querySelector("img,video");if(!el)return null;var isV=el.tagName==="VIDEO";var nw=isV?el.videoWidth:el.naturalWidth,nh=isV?el.videoHeight:el.naturalHeight;var key=keyOf(el.currentSrc||el.src);var cached=key&&self.__sandMediaMeta?self.__sandMediaMeta.get(key):null;var loading=isV?el.readyState<1:(!el.complete||el.naturalWidth===0);return{el:el,isV:isV,nw:nw,nh:nh,key:key,cached:cached,loading:loading}};'
  // Gallery tiles are cover-cropped uniform cells BY DESIGN (locked ruleset:
  // cell geometry depends only on count, never aspect) - judging them by the
  // single-image natural-aspect standard painted every healthy tile red. A
  // tile is healthy ("cover") when the source has enough pixels to fill the
  // cell; red only when the cell would upscale. Single images keep the
  // strict aspect + no-upscale standard.
  // A letterboxed tile draws the picture scaled to fit, not to fill, so it is
  // judged on the drawn rectangle - otherwise a sharp contained image would
  // still be reported as an upscale of the cell it sits in.
  + 'var drawnRect=function(m,r){try{if(!m||!m.el||!(m.nw>0))return r;var of=getComputedStyle(m.el).objectFit;if(of!=="contain"&&of!=="scale-down")return r;var s=Math.min(r.width/m.nw,r.height/m.nh);s>1&&(s=1);return{width:m.nw*s,height:m.nh*s}}catch(_){return r}};'
  + 'var judge=function(m,r0,tile){if(!m||!(m.nw>0))return"unknown";var r=drawnRect(m,r0);if(tile)return m.nw>=r.width-1&&m.nh>=r.height-1?"cover":"unnatural";var far=r.width/r.height,iar=m.nw/m.nh;return(Math.abs(far-iar)/iar<.02&&r.width<=m.nw*1.02+1)?"natural":"unnatural"};'
  + 'var isTile=function(f){return!!(f&&f.classList&&f.classList.contains("sand-image-row__tile"))||!!(f&&f.closest&&f.closest(".sand-image-row__tile"))};'
  // asRow forces the neutral row treatment: a row CONTAINING images must not
  // borrow a media verdict (that painted whole gallery rows red while the
  // panel said "not media").
  + 'var drawBox=function(f,withTag,asRow){var r=f.getBoundingClientRect();if(r.width<8||r.height<8||r.bottom<0||r.top>innerHeight)return null;var m=asRow?null:mediaInfo(f);var box=document.createElement("div");box.className="smd-box";box.style.left=r.left+"px";box.style.top=r.top+"px";box.style.width=r.width+"px";box.style.height=r.height+"px";'
  + 'if(m&&m.nw>0){var v=judge(m,r,isTile(f));box.style.border=m.cached?("2px solid "+(v==="natural"||v==="cover"?"#00c853":"#ff1744")):"2px dashed #9e9e9e";if(withTag){var tag=document.createElement("div");tag.className="smd-tag";tag.style.left="2px";tag.style.bottom="2px";tag.textContent=m.nw+"x"+m.nh+" > "+Math.round(r.width)+"x"+Math.round(r.height)+(v==="cover"?" cover":v==="natural"?"":" !");box.appendChild(tag)}}else if(m){box.style.border="2px dashed #9e9e9e"}else{box.style.border="2px solid #3d8bff"}'
  + 'if(m){var dot=document.createElement("div");dot.className="smd-dot"+(m.loading?" smd-spin":"");dot.style.right="3px";dot.style.top="3px";if(!m.loading)dot.style.background=m.cached?(m.cached.thumb?"#0d47a1":"#1d9bf0"):"#9e9e9e";box.appendChild(dot)}'
  + 'layer.appendChild(box);return{rect:r,media:m}};'
  + 'var MEDIA_SEL=".sand-attachment__image-frame,.sand-image-row__tile";'
  + 'var sweep=function(){layer.textContent="";if(document.querySelector(".sand-media-viewer,[aria-modal=\\"true\\"]")){setBadge("SWEEP \\u00b7 PAUSED");return}setBadge("SWEEP");var sc=document.querySelector(".sand-virtual-transcript");if(!sc)return;sc.querySelectorAll(MEDIA_SEL).forEach(function(f){drawBox(f,true)})};'
  + 'var panel=document.createElement("div");panel.className="smd-panel";panel.hidden=true;'
  + 'var modeTag=document.createElement("div");modeTag.className="smd-mode";modeTag.hidden=true;'
  + 'var line=function(k,v){return"<b>"+k+"</b> "+String(v).replace(/[<>&]/g,function(ch){return ch==="<"?"&lt;":ch===">"?"&gt;":"&amp;"})+"<br>"};'
  // Geometry hit-testing instead of elementFromPoint: hover overlays and
  // portal layers over media used to swallow the hit (the image showed no box
  // while the row around it did). Rect containment is immune to that; the
  // smallest containing media candidate wins, rows are the fallback.
  // Priority ladder: media frame -> bubble/card -> whole row. The bubble is
  // found generically: take the element stack under the cursor
  // (elementsFromPoint sees through hover overlays), walk up from the deepest
  // node toward the row, and keep the outermost container that is meaningfully
  // narrower than the row - that IS the chat bubble or card. Only when the
  // cursor sits in the row gutter does the row itself answer.
  + 'var pick=function(x,y){var sc=document.querySelector(".sand-virtual-transcript");if(!sc)return null;var best=null;sc.querySelectorAll(MEDIA_SEL+",img,video").forEach(function(f){var r=f.getBoundingClientRect();if(r.width<8||r.height<8||x<r.left||x>r.right||y<r.top||y>r.bottom)return;var a=r.width*r.height;if(!best||a<best.a)best={el:f,media:true,a:a}});if(best)return best;'
  + 'var row=null,rows=sc.querySelectorAll("[data-row-key]");for(var i=0;i<rows.length;i++){var rr=rows[i].getBoundingClientRect();if(rr.height>4&&x>=rr.left&&x<=rr.right&&y>=rr.top&&y<=rr.bottom){row=rows[i];break}}if(!row)return null;'
  // Walk deepest -> row keeping two candidates: the INNERMOST "component-ish"
  // node (painted background, real border radius, or button/link semantics -
  // this is the audio chip, the file card, the tiny math bubble) and the
  // OUTERMOST narrow container (the bubble). Focus prefers the component,
  // then the bubble, then the row. Size floors are small on purpose: a lone
  // x^2 math bubble is ~30px wide and must still win over its row. Inline
  // text spans never qualify (display check), so words don't get boxed.
  // Focus candidates, innermost first: any SMALL LEAF element (icon glyphs,
  // time/size labels, scrubber thumbs - none of which are svg or painted, so
  // tag/paint tests alone miss them), form controls (the audio scrubber is an
  // input[type=range]), and painted/rounded/button-ish containers. Wide leafs
  // (a paragraph of bubble text) stay excluded so prose still resolves to its
  // bubble. Inline elements can be focus (a label) but never the bubble.
  + 'var stack=(document.elementsFromPoint?document.elementsFromPoint(x,y):[]).filter(function(e){return row.contains(e)});var deep=stack[0]||null;var rw=row.getBoundingClientRect().width;var focus=null,bub=null,n=deep;while(n&&n!==row){var br=n.getBoundingClientRect();if(br.width>=8&&br.height>=8&&br.width<rw*0.95){var cs=getComputedStyle(n);var tg=String(n.tagName).toUpperCase();var leafSmall=n.childElementCount===0&&br.width<=420&&br.height<=64;var bg=cs.backgroundColor;var painted=bg&&bg!=="transparent"&&bg!=="rgba(0, 0, 0, 0)";var compish=leafSmall||painted||parseFloat(cs.borderTopLeftRadius)>=6||tg==="BUTTON"||tg==="A"||tg==="INPUT"||tg==="PROGRESS"||tg==="SVG"||n.getAttribute("role")==="button";if(!focus&&compish&&(cs.display!=="inline"||leafSmall))focus=n;if(cs.display!=="inline")bub=n}n=n.parentElement}'
  + 'return{el:focus||bub||row,media:false,row:row,level:focus?"component":bub?"bubble/card":"row",bub:bub}};'
  // Occlusion: the topmost real element under the cursor decides. Transcript
  // content on top -> inspect; the image's own hover chrome (rect mostly
  // inside the media frame) -> exempt, keep inspecting the media; anything
  // else on top (viewer, dialog, popover, composer) -> paused at that point.
  + 'var occl=function(x,y,mediaRect){var st=document.elementsFromPoint?document.elementsFromPoint(x,y):[];var sc=document.querySelector(".sand-virtual-transcript");for(var i=0;i<st.length;i++){var e=st[i];var c=String(e.className&&e.className.baseVal!==undefined?e.className.baseVal:e.className||"");if(c.indexOf("smd-")>=0||c.indexOf("sand-sel-")>=0||c.indexOf("sand-jump-newest")>=0)continue;if(sc&&sc.contains(e))return null;if(mediaRect){var r=e.getBoundingClientRect();var ox=Math.max(0,Math.min(r.right,mediaRect.right)-Math.max(r.left,mediaRect.left));var oy=Math.max(0,Math.min(r.bottom,mediaRect.bottom)-Math.max(r.top,mediaRect.top));var ea=r.width*r.height;if(ea>0&&ox*oy/ea>=0.6)continue}return e}return null};'
  + 'var skelLines=function(sk){var out=line("skeleton",sk.sw+" x "+sk.sh);if(sk.fw!=null){out+=line("after load",sk.fw+" x "+sk.fh);var dw=Math.abs(sk.fw-sk.sw),dh=Math.abs(sk.fh-sk.sh);var ok=dw<=1&&dh<=1;var ar=sk.sh>0&&sk.fh>0?Math.abs(sk.sw/sk.sh-sk.fw/sk.fh)/(sk.fw/sk.fh):1;out+=line("skeleton match",ok?"exact":ar<0.02?"aspect ok (\\u0394 "+dw+" x "+dh+")":"MISMATCH (\\u0394 "+dw+" x "+dh+")")}return out};'
  // Viewer mode: while the media viewer is open, no boxes over the buried
  // page - just one pinned stats chip for the viewer's own image.
  + 'var viewerStats=function(v){layer.textContent="";var img=v.querySelector(".sand-media-viewer__image")||v.querySelector("img,video");if(!img){panel.hidden=true;return}var isV=img.tagName==="VIDEO";var nw=isV?img.videoWidth:img.naturalWidth,nh=isV?img.videoHeight:img.naturalHeight;var r=img.getBoundingClientRect();var src=img.currentSrc||img.src;var key=keyOf(src);var cached=key&&self.__sandMediaMeta?self.__sandMediaMeta.get(key):null;var h=line("viewer",isV?"video":"image");if(nw>0){h+=line("natural",nw+" x "+nh);h+=line("rendered",Math.round(r.width)+" x "+Math.round(r.height));h+=line("scale",Math.round(r.width/nw*100)+"%")}h+=line("cache",cached?(cached.thumb?"dims + poster thumb":"dims"):"none");var sk=self.__sandSkel?self.__sandSkel.get(src):null;if(sk)h+=skelLines(sk);if(key)h+=line("key","\\u2026"+String(key).slice(-40));panel.innerHTML=h;panel.hidden=false;panel.style.left="14px";panel.style.top=Math.max(14,innerHeight-190)+"px"};'
  // Layout lint: an always-on silent watcher. On idle ticks (hard budget,
  // skipped while scrolling or while the viewer is open) it judges the
  // cached media frames near the viewport and records every REAL violation -
  // single-image aspect/upscale breaks, tile upscales, skeleton-vs-final
  // mismatches - deduped by media key into a persistent store. By-design
  // cover crops and unjudgeable first loads are never findings. The report
  // is always ready: __sandLayoutReport() aggregates it any time (CDP or a
  // later session), and the mode badge carries the live flag count.
  + 'var LF_K="sandLayoutFindings.v1",lfm=null,lft=0;'
  + 'var lfLoad=function(){if(lfm)return lfm;lfm=new Map();try{var raw=localStorage.getItem(LF_K);if(raw){var o=JSON.parse(raw);for(var k in o)lfm.set(k,o[k])}}catch(_){}return lfm};'
  + 'var lfSave=function(){lft||(lft=setTimeout(function(){lft=0;try{var o={},keys=Array.from(lfm.keys());for(var i=Math.max(0,keys.length-300);i<keys.length;i++)o[keys[i]]=lfm.get(keys[i]);localStorage.setItem(LF_K,JSON.stringify(o))}catch(_){}},1500))};'
  + 'var lintFlag=function(f){var m=lfLoad();var fk=f.kind+"|"+f.reason+"|"+keyOf(f.key||"");var e=m.get(fk);if(e){e.count++;e.lastAt=Date.now();e.rendered=f.rendered}else{m.delete(fk);m.set(fk,{kind:f.kind,reason:f.reason,key:String(keyOf(f.key||"")||"").slice(-80),agent:f.agent||"",natural:f.natural||"",rendered:f.rendered||"",skeleton:f.skeleton||"",count:1,firstAt:Date.now(),lastAt:Date.now()})}lfSave()};'
  + 'var lintScrollTs=0;document.addEventListener("scroll",function(){lintScrollTs=Date.now()},true);'
  + 'var lintOn=function(){try{return localStorage.getItem("sandLayoutLint")==="1"}catch(_){return false}};'
  + 'var lintTick=function(){try{if(!lintOn())return;if(document.querySelector(".sand-media-viewer"))return;if(Date.now()-lintScrollTs<600)return;var sc=document.querySelector(".sand-virtual-transcript");if(!sc)return;var ag=(self.__sandCurrentAgent&&self.__sandCurrentAgent())||"";'
  + 'var frames=sc.querySelectorAll(MEDIA_SEL);var budget=24;'
  + 'for(var i=0;i<frames.length&&budget>0;i++){var fr=frames[i];var r=fr.getBoundingClientRect();if(r.width<8||r.bottom<-innerHeight||r.top>innerHeight*2)continue;budget--;var m=mediaInfo(fr);if(!m||!(m.nw>0)||!m.cached||m.loading)continue;var tl=isTile(fr);var reason;'
  // A green box means "not upscaled in CSS pixels" - on a Retina screen a
  // crisp image still needs devicePixelRatio times that many real pixels, so
  // anything that passes the box test but misses the device test is reported
  // as its own softer tier instead of silently counting as fine.
  // Vectors rasterise sharp at any size, so neither verdict applies to them.
  + 'if(/\\.svgx?($|\\?)/i.test(String(m.key||""))||/image\\/svg/.test(m.el&&m.el.getAttribute("type")||""))continue;'
  + 'if(judge(m,r,tl)==="unnatural"){if(tl)reason="tile-upscale";else{var far=r.width/r.height,iar=m.nw/m.nh;reason=Math.abs(far-iar)/iar>=.02?"cropped":"upscaled"}}else{var dpr=window.devicePixelRatio||1;if(dpr<=1.05)continue;'
  // Sharpness is judged on the pixels actually DRAWN (a letterboxed picture
  // fills less than its box), and a source that could not satisfy the demand
  // even at the largest variant is source-limited: real, but not our bug.
  + 'var dr=drawnRect(m,r);if(m.nw>=dr.width*dpr-1&&m.nh>=dr.height*dpr-1)continue;reason=(m.nw>=2047||m.nh>=2047)?"under-dpr-fetch":"under-dpr-source"}'
  + 'lintFlag({kind:tl?"tile":(m.isV?"video":"single"),reason:reason,key:m.key,agent:ag,natural:m.nw+"x"+m.nh,rendered:Math.round(r.width)+"x"+Math.round(r.height)+(reason.indexOf("under-dpr")===0?"@"+(window.devicePixelRatio||1)+"x":"")})}'
  + 'self.__sandSkel&&self.__sandSkel.each(function(k,sk){if(sk.fw==null||sk.lf)return;sk.lf=1;var dw=Math.abs(sk.fw-sk.sw),dh=Math.abs(sk.fh-sk.sh);if(dw<=1&&dh<=1)return;var ar=sk.sh>0&&sk.fh>0?Math.abs(sk.sw/sk.sh-sk.fw/sk.fh)/(sk.fw/sk.fh):1;if(ar<0.02)return;lintFlag({kind:"skeleton",reason:"skeleton-mismatch",key:k,agent:ag,skeleton:sk.sw+"x"+sk.sh,rendered:sk.fw+"x"+sk.fh})})'
  + '}catch(_){}};'
  + 'var lintSched=function(){var ric=window.requestIdleCallback||function(cb){setTimeout(cb,500)};ric(function(){lintTick();setTimeout(lintSched,2000)},{timeout:4000})};setTimeout(lintSched,4000);'
  + 'var setBadge=function(t){var n=lfLoad().size;modeTag.textContent=t+(n>0?" \\u00b7 \\u2691"+n:"")};'
  + 'window.__sandLayoutReport=function(){var m=lfLoad();var arr=[];m.forEach(function(v){arr.push(v)});arr.sort(function(a,b){return b.count-a.count});var by=function(field){var o={};arr.forEach(function(f){var v=f[field]||"?";o[v]=(o[v]||0)+1});return o};return{generatedAt:new Date().toISOString(),total:arr.length,byReason:by("reason"),byKind:by("kind"),byAgent:by("agent"),findings:arr.slice(0,100)}};'
  + 'window.__sandLayoutReport.clear=function(){lfLoad().clear();lfSave();return true};'
  + 'window.__sandLayoutReport.enable=function(){try{localStorage.setItem("sandLayoutLint","1")}catch(_){}return true};'
  + 'window.__sandLayoutReport.disable=function(){try{localStorage.setItem("sandLayoutLint","0")}catch(_){}return true};'
  + 'window.__sandLayoutReport.active=function(){return lintOn()};'
  + 'var lastXY=null;var inspect=function(x,y){layer.textContent="";panel.hidden=true;var vw=document.querySelector(".sand-media-viewer");if(vw){setBadge("INSPECT");viewerStats(vw);return}var sc=document.querySelector(".sand-virtual-transcript");if(!sc)return;var hit=pick(x,y);if(!hit){setBadge("INSPECT");return}var mr=hit.media?hit.el.getBoundingClientRect():null;var oc=occl(x,y,mr);if(oc){setBadge("INSPECT \\u00b7 PAUSED");return}setBadge("INSPECT");var f=hit.media?hit.el:null;var row=hit.media?(hit.el.closest?hit.el.closest("[data-row-key]"):null):hit.row;var target=hit.el;if(!target)return;var got=drawBox(target,!!f,!f);if(!got)return;var h="";'
  + 'if(f&&got.media){var m=got.media,r=got.rect,tl=isTile(target),v=judge(m,r,tl);h+=line("component",m.isV?"video frame":(tl?"gallery tile":"image frame"));if(m.nw>0){h+=line("natural",m.nw+" x "+m.nh);h+=line("rendered",Math.round(r.width)+" x "+Math.round(r.height));h+=line("scale",Math.round(r.width/m.nw*100)+"%");var dpr=window.devicePixelRatio||1;if(dpr>1.05)h+=line("sharpness",(Math.round(Math.min(m.nw/r.width,m.nh/r.height)*100)/100)+"x of "+dpr+"x needed");h+=line("verdict",m.cached?(v==="cover"?"cover crop (by design, green)":v==="natural"?"natural (green)":tl?"upscaled in cell (red)":"cropped/upscaled (red)"):"not judged - dims not cached yet")}else{h+=line("verdict","not decoded yet")}h+=line("cache",m.cached?(m.cached.thumb?"dims + poster thumb":"dims"):"none");var sk2=self.__sandSkel&&m.el?self.__sandSkel.get(m.el.currentSrc||m.el.src):null;if(sk2)h+=skelLines(sk2);if(m.loading)h+=line("state","loading\\u2026");if(m.key)h+=line("key","\\u2026"+String(m.key).slice(-42))}'
  + 'else{h+=line("component",kindOfRow(row)+" \\u00b7 "+(hit.level||"row"));h+=line("row key",row.getAttribute("data-row-key")||"?");var eid=row.getAttribute("data-entry-id")||((row.getAttribute("data-row-key")||"").match(/^t[0-9]+[a-z][0-9a-z]*$/)||[])[0];if(eid)h+=line("entry id",eid);h+=line("rendered",Math.round(got.rect.width)+" x "+Math.round(got.rect.height));if(hit.bub&&hit.bub!==hit.el){var bubR=hit.bub.getBoundingClientRect();h+=line("bubble",Math.round(bubR.width)+" x "+Math.round(bubR.height))}if(hit.level!=="row"){var rowR=row.getBoundingClientRect();h+=line("row",Math.round(rowR.width)+" x "+Math.round(rowR.height))}h+=line("verdict","no size contract (not media)")}'
  + 'panel.innerHTML=h;panel.hidden=false;var px=Math.min(x+16,innerWidth-316),py=Math.min(y+16,innerHeight-140);panel.style.left=px+"px";panel.style.top=py+"px"};'
  + 'var onMove=function(e){lastXY=[e.clientX,e.clientY];if(mode===1){raf||(raf=requestAnimationFrame(function(){raf=0;lastXY&&inspect(lastXY[0],lastXY[1])}))}};var raf=0;'
  + 'var set=function(v){mode=v;try{localStorage.setItem(K,String(v))}catch(_){}'
  + 'document.head.contains(style)||document.head.appendChild(style);document.body.contains(layer)||document.body.appendChild(layer);document.body.contains(panel)||document.body.appendChild(panel);document.body.contains(modeTag)||document.body.appendChild(modeTag);'
  + 'layer.style.display=v?"block":"none";layer.textContent="";panel.hidden=true;modeTag.hidden=!v;v&&setBadge(v===1?"INSPECT":"SWEEP");'
  + 'iv&&clearInterval(iv);iv=null;document.removeEventListener("mousemove",onMove,true);'
  + 'if(v===1){document.addEventListener("mousemove",onMove,true);iv=setInterval(function(){lastXY&&inspect(lastXY[0],lastXY[1])},600);lastXY&&inspect(lastXY[0],lastXY[1])}'
  + 'else if(v===2){iv=setInterval(sweep,400);sweep()}};'
  // First debugger use arms the lint (an explicit "0" set via
  // __sandLayoutReport.disable() is respected and never re-armed here).
  + 'var armLint=function(){try{localStorage.getItem("sandLayoutLint")==null&&localStorage.setItem("sandLayoutLint","1")}catch(_){}};'
  + 'self.__sandMediaDebug={enable:function(){armLint();set(2)},disable:function(){set(0)},inspect:function(){armLint();set(1)},toggle:function(){var n=(mode+1)%3;n&&armLint();set(n)},mode:function(){return mode}};'
  + 'document.addEventListener("keydown",function(e){if((e.metaKey||e.ctrlKey)&&e.shiftKey&&(e.key==="D"||e.key==="d")){e.preventDefault();set((mode+1)%3)}},true);'
  + '}catch(_){}})();\n';

// Per-agent composer drafts (0.29 parity, local analog of sendDraft/
// discardDraft): unsent composer text persists per agent in localStorage,
// restored when that chat's empty composer mounts, cleared on send. Text
// only - attachments and rich marks are not preserved.
const DRAFTS_HELPER = ';(()=>{try{'
  + 'var K="sandDrafts.v1",map=null,t=0,cur=null,restoring=false;'
  + 'var load=function(){if(map)return map;try{map=JSON.parse(localStorage.getItem(K)||"{}")}catch(_){map={}}return map};'
  + 'var save=function(){t||(t=setTimeout(function(){t=0;try{localStorage.setItem(K,JSON.stringify(map))}catch(_){}},400))};'
  + 'var field=function(){return document.querySelector(".sand-prompt-field")};'
  + 'var put=function(id,text){if(!id)return;var m=load();if(text&&text.trim())m[id]=text;else delete m[id];save()};'
  + 'var restore=function(id){var ed=field();if(!ed||!id)return;var d=load()[id];if(!d||ed.textContent.trim()!=="")return;restoring=true;try{ed.focus();document.execCommand("insertText",false,d)}catch(_){}restoring=false};'
  + 'document.addEventListener("click",function(ev){var it=ev.target&&ev.target.closest?ev.target.closest(".sand-agent-item[data-agent-id]"):null;if(!it)return;var id=it.getAttribute("data-agent-id");if(cur&&cur!==id){var ed=field();if(ed)put(cur,ed.textContent)}cur=id;setTimeout(function(){restore(id)},650)},true);'
  + 'document.addEventListener("input",function(ev){if(restoring)return;var ed=ev.target&&ev.target.closest?ev.target.closest(".sand-prompt-field"):null;if(ed&&cur)put(cur,ed.textContent)},true);'
  + 'document.addEventListener("keydown",function(ev){if(ev.key!=="Enter"||ev.shiftKey)return;var ed=ev.target&&ev.target.closest?ev.target.closest(".sand-prompt-field"):null;if(ed&&cur){var m=load();delete m[cur];save()}},true);'
  + 'self.__sandCurrentAgent=function(){return cur};'
  + 'setTimeout(function(){var pressed=document.querySelector(".sand-agent-item[aria-pressed=true][data-agent-id]");if(pressed){cur=pressed.getAttribute("data-agent-id");restore(cur)}},1600)'
  + '}catch(_){}})();\n';

// The local-tool consent prompt hardcodes one title - "run commands on your
// local computer" - for every action the gate covers. ExternalRead, the
// directory listing and the file-transfer tools all route through the same
// prompt, so today the app asks permission to run commands when it wants to
// read a file. The ask carries the action already; this names it.
const LOCAL_TOOL_ASK_HELPER = ';(()=>{try{'
  + 'var T={'
  + '"run-command":"run commands on your local computer",'
  + '"send-input":"type into a command running on your local computer",'
  + '"read-file":"read files on your local computer",'
  + '"list-directory":"list folders on your local computer",'
  + '"write-file":"write files on your local computer",'
  + '"read-messages":"read your Messages conversations on this Mac",'
  + '"send-imessage":"send iMessages from your account"'
  + '};'
  + 'self.__sandLocalToolAskTitle=function(action){var what=T[action];'
  + 'return what?"Allow Grok Bot and all agents to "+what+"?":""};'
  + '}catch(_){}})();\n';

// A screen reader is told nothing when a reply starts or finishes: the
// transcript updates silently, so the only way to know the bot has answered is
// to go looking. The bundle has no shared announce hook to reuse - every
// aria-live in it is a one-off - so this owns its own live region.
//
// A streaming assistant row carries data-pending, which is the signal used
// here. It needs no exact-string anchor at all, so nothing can drift out from
// under it. Turn boundaries only: announcing tokens would be unusable noise.

// Keeps the renderer's view of "are we on an OpenGrok server" in sync, because
// the login gate runs long before any React state exists and can only read
// localStorage synchronously. Written by the app, read by the wall.
const OPENGROK_MODE_HELPER = ';(()=>{try{'
  + 'var K="' + "sand-opengrok-mode" + '";'
  + 'var apply=function(on){try{if(on)localStorage.setItem(K,"1");else localStorage.removeItem(K)}catch(_){}};'
  + 'self.__sandSetOpenGrokMode=apply;'
  + 'var read=function(){try{window.desktop.agent.getBoxRuntime().then(function(r){if(r!=null)apply(r.mode==="opengrok")}).catch(function(){})}catch(_){}};'
  + 'read();setInterval(read,15e3);'
  + 'window.addEventListener("sand-box-runtime-changed",read);'
  + 'window.addEventListener("sand-opengrok-changed",read);'
  + '}catch(_){}})();\n';

// The login page's provider chooser: a gear in the corner opens a sheet where
// you pick who signs you in, and the page's own chrome follows the choice.
// Replaces "Choose Other Provider", which skipped the wall rather than letting
// anyone choose anything.
//
// The provider glyphs are our own simple marks, not the official brand assets -
// enough to tell the options apart, and swappable for real ones later.
const LOGIN_PROVIDER_HELPER = ';(()=>{try{'
  + 'var g=document.createElement("style");g.setAttribute("data-sand-login-gate","1");'
  + 'g.textContent=".sand-onboarding:not([data-lp-show]){visibility:hidden!important}"'
  + '+".sand-lp-splash{position:fixed;inset:0;z-index:2147483600;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:var(--sand-bg-base,#0b0b0c);color:var(--sand-text-primary,#f2f2f2);font-family:inherit}"'
  + '+".sand-lp-splash[data-going]{opacity:0;transition:opacity .28s ease}"'
  + '+".sand-lp-orb{position:relative;width:74px;height:74px;display:flex;align-items:center;justify-content:center}"'
  + '+".sand-lp-orb i{position:absolute;inset:0;border-radius:50%;border:1.5px solid currentColor;opacity:.16;animation:sand-lp-pulse 2.1s cubic-bezier(.4,0,.2,1) infinite}"'
  + '+".sand-lp-orb i:nth-child(2){animation-delay:.7s}.sand-lp-orb i:nth-child(3){animation-delay:1.4s}"'
  + '+".sand-lp-orb b{width:30px;height:30px;border-radius:50%;background:currentColor;opacity:.92;animation:sand-lp-breathe 2.1s ease-in-out infinite}"'
  + '+"@keyframes sand-lp-pulse{0%{transform:scale(.55);opacity:.30}70%{opacity:0}100%{transform:scale(1.25);opacity:0}}"'
  + '+"@keyframes sand-lp-breathe{0%,100%{transform:scale(1)}50%{transform:scale(.86)}}"'
  + '+".sand-lp-splash p{margin:0;font-size:14px;letter-spacing:.02em;opacity:.62;animation:sand-lp-fadein .5s ease-out both}"'
  + '+"@keyframes sand-lp-fadein{from{opacity:0;transform:translateY(4px)}to{opacity:.62;transform:none}}";'
  + '(document.head||document.documentElement).appendChild(g);'
  + 'var splash=null;'
  + 'var showSplash=function(){if(splash&&splash.isConnected)return;'
  + 'splash=document.createElement("div");splash.className="sand-lp-splash";splash.setAttribute("role","status");splash.setAttribute("aria-live","polite");'
  + 'splash.innerHTML=\'<div class="sand-lp-orb"><i></i><i></i><i></i><b></b></div><p>Starting Open Grok\\u2026</p>\';'
  + '(document.body||document.documentElement).appendChild(splash)};'
  + 'var hideSplash=function(){if(!splash||!splash.isConnected)return;splash.setAttribute("data-going","1");'
  + 'var s=splash;splash=null;setTimeout(function(){try{s.remove()}catch(_){}} ,300)};'
  + 'showSplash();if(!document.body)document.addEventListener("DOMContentLoaded",showSplash);'
  + 'setTimeout(function(){try{hideSplash();if(!document.querySelector(".sand-lp-sheet"))'
  + 'document.querySelectorAll(".sand-onboarding").forEach(function(n){n.setAttribute("data-lp-show","1")})}catch(_){}} ,6000);'
  + 'var MODE_K="sand-opengrok-mode";'
  + 'var G=function(d,extra){return \'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\'+(extra||"")+d+"</svg>"};'
  + 'var P=[' 
  +   '{id:"cursor",label:"Cursor",title:"Grok Bot",lede:"Your team of always-on agents that you can give real work to.",how:"Signing in opens your browser to Cursor.",tag:"Sign in with the Cursor account this app was built for.",accent:"#8b8b8b",'
  +    'svg:G(\'<path d="M12 3 20 7.5v9L12 21 4 16.5v-9z"/><path d="M12 3v18M4 7.5l8 4.5 8-4.5"/>\')},'
  +   '{id:"opengrok",label:"OpenGrok Server",title:"Open Grok",lede:"Your bots live on your own server, and the work runs there.",how:"Signing in opens your browser to your server.",tag:"Your own server holds the bots and runs their work.",accent:"#4ec9a5",'
  +    'svg:G(\'<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4a13 13 0 0 1 0 16a13 13 0 0 1 0-16z"/>\')},'
  +   '{id:"codex",label:"Codex",title:"Codex",lede:"Your ChatGPT subscription, running your bots.",how:"Signing in opens a terminal and runs the Codex login on this Mac.",tag:"Your ChatGPT subscription, signed in on this Mac.",accent:"#74aa9c",'
  +    'svg:G(\'<path d="M12 3.2 18.6 7v10L12 20.8 5.4 17V7z"/><path d="M12 12l6.6-3.8M12 12v8.8M12 12 5.4 8.2"/>\')},'
  +   '{id:"claude-code",label:"Claude",title:"Claude",lede:"Your Claude subscription, running your bots.",how:"Signing in opens a terminal and runs the Claude login on this Mac.",tag:"Your Claude subscription, signed in on this Mac.",accent:"#d97757",'
  +    'svg:G(\'<path d="M12 4v16M4.8 7.6l14.4 8.8M19.2 7.6 4.8 16.4"/>\')}'
  + '];'
  + 'var byId=function(id){for(var i=0;i<P.length;i++)if(P[i].id===id)return P[i];return P[0]};'
  + 'var cur=null,busy=!1,ready=!1,openRows=null;'
  // ---- styles, theme-aware ----
  + 'var css=".sand-lp-back{position:absolute;top:54px;left:18px;z-index:2147482000;width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid var(--sand-border-default,rgba(128,128,128,.28));background:var(--sand-bg-elevated,rgba(128,128,128,.10));color:var(--sand-text-primary,inherit);opacity:.72;transition:opacity .15s,transform .15s}"'
  + '+".sand-lp-back:hover{opacity:1;transform:translateX(-2px)}"'
  + '+".sand-lp-back svg{width:18px;height:18px}"'
  + '+".sand-lp-scrim{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--sand-bg-base,Canvas);animation:sand-lp-fade .16s ease-out}"'
  + '+"@keyframes sand-lp-fade{from{opacity:0}to{opacity:1}}"'
  + '+"@keyframes sand-lp-rise{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}"'
  + '+"@keyframes sand-lp-mark{from{opacity:0;transform:scale(.82) rotate(-8deg)}to{opacity:1;transform:none}}"'
  + '+".sand-lp-sheet{width:min(520px,100%);max-height:84vh;overflow:auto;border-radius:14px;padding:22px;animation:sand-lp-rise .2s cubic-bezier(.2,.8,.3,1);border:1px solid var(--sand-border-default,rgba(128,128,128,.28));background:var(--sand-bg-elevated,Canvas);color:var(--sand-text-primary,CanvasText);box-shadow:0 24px 70px rgba(0,0,0,.34)}"'
  + '+".sand-lp-h{font-size:17px;font-weight:600;margin:0 0 3px}"'
  + '+".sand-lp-sub{font-size:13px;opacity:.7;margin:0 0 16px}"'
  + '+".sand-lp-opt{display:flex;gap:13px;align-items:flex-start;width:100%;text-align:left;padding:12px 13px;border-radius:10px;cursor:pointer;border:1px solid transparent;background:transparent;color:inherit;font:inherit;transition:background .12s,border-color .12s}"'
  + '+".sand-lp-opt:hover{background:var(--sand-fill-ghost-hover,rgba(128,128,128,.10))}"'
  + '+".sand-lp-opt[aria-checked=true]{border-color:var(--a);background:var(--sand-fill-ghost-selected,rgba(128,128,128,.14))}"'
  + '+".sand-lp-ic{flex:none;width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;color:var(--a);border:1px solid color-mix(in oklch,var(--a) 34%,transparent);background:color-mix(in oklch,var(--a) 12%,transparent)}"'
  + '+".sand-lp-ic svg{width:19px;height:19px}"'
  + '+".sand-lp-nm{font-size:14px;font-weight:600}"'
  + '+".sand-lp-tg{font-size:12.5px;opacity:.68;margin-top:2px;line-height:1.45}"'
  + '+".sand-lp-extra{margin:10px 0 0 47px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}"'
  + '+".sand-lp-in{flex:1 1 240px;min-width:0;height:34px;padding:0 10px;font:inherit;font-size:13px;border-radius:8px;border:1px solid var(--sand-border-default,rgba(128,128,128,.32));background:var(--sand-bg-base,transparent);color:inherit}"'
  + '+".sand-lp-btn{height:32px;padding:0 13px;font:inherit;font-size:13px;font-weight:500;border-radius:8px;cursor:pointer;border:1px solid var(--sand-border-default,rgba(128,128,128,.32));background:var(--sand-fill-ghost-hover,rgba(128,128,128,.10));color:inherit}"'
  + '+".sand-lp-btn:disabled{opacity:.45;cursor:default}"'
  + '+".sand-lp-msg{font-size:12.5px;opacity:.72;margin:9px 0 0 47px}"'
  + '+".sand-lp-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}"'
  + '+".sand-lp-mark{display:inline-flex;align-items:center;justify-content:center;animation:sand-lp-mark .42s cubic-bezier(.2,.8,.3,1)}"'
  + '+".sand-onboarding[data-lp-page]{--lp-a:var(--lp-accent,#8b8b8b)}"'
  + '+".sand-onboarding[data-lp-page] [data-lp-mark]{filter:drop-shadow(0 0 26px color-mix(in oklch,var(--lp-a) 55%,transparent))}"'
  + '+".sand-lp-rule{width:44px;height:2px;border-radius:2px;margin:14px auto 12px;background:var(--lp-a);opacity:.9}"'
  + '+".sand-lp-how{margin:10px 0 0;font-size:12.5px;line-height:1.5;opacity:.62;text-align:center}"'
  + '+".sand-lp-cli{margin:6px 0 0;font-size:12.5px;font-weight:500;text-align:center;color:var(--lp-a)}"'
  + '+".sand-lp-mark svg{width:1em;height:1em}";'
  + 'var styled=!1,style=function(){if(styled)return;styled=!0;var t=document.createElement("style");t.setAttribute("data-sand-login-provider","1");t.textContent=css;document.head.appendChild(t)};'
  // ---- read current provider ----
  + 'var read=function(){var a=window.desktop&&window.desktop.agent;if(!a)return Promise.resolve(null);'
  +   'return Promise.all([a.getInferenceRouter().catch(function(){return null}),a.getBoxRuntime().catch(function(){return null})]).then(function(r){'
  +   'var prov=r[0]&&r[0].provider,box=r[1]&&r[1].mode;return box==="opengrok"?"opengrok":(prov||"cursor")})};'
  // ---- rewrite the page chrome for the chosen provider ----
  + 'var chrome=function(p,given){var root=given||document.querySelector(".sand-onboarding");if(!root)return;'
  + 'var h=null,heads=root.querySelectorAll("h1,h2,[class*=title]");'
  + 'for(var i=0;i<heads.length;i++){var t=(heads[i].textContent||"").trim();if(/^(Grok Bot|Open Grok|Codex|Claude|Cursor)$/i.test(t)){h=heads[i];break}}'
  + 'if(!h)return;var host=h.parentElement;if(!host)return;'
  + 'root.style.setProperty("--lp-accent",p.accent);root.setAttribute("data-lp-page",p.id);'
  + 'var lede=root.querySelector("[data-lp-lede]");'
  + 'if(!lede){var ps=root.querySelectorAll("p,span,div");'
  + 'for(var q=0;q<ps.length;q++){var n2=ps[q];if(n2.children.length)continue;'
  + 'if(/always-on agents/i.test(n2.textContent||"")){n2.setAttribute("data-lp-lede","1");lede=n2;break}}}'
  + 'if(lede)lede.textContent=p.lede;'
  + 'if(lede&&lede.parentElement&&!root.querySelector("[data-lp-rule]")){'
  + 'var rule=document.createElement("div");rule.setAttribute("data-lp-rule","1");rule.className="sand-lp-rule";'
  + 'lede.parentElement.insertBefore(rule,lede);}'
  + 'var how=root.querySelector("[data-lp-how]");'
  + 'if(!how&&lede&&lede.parentElement){how=document.createElement("p");how.setAttribute("data-lp-how","1");how.className="sand-lp-how";'
  + 'lede.parentElement.insertBefore(how,lede.nextSibling);}'
  + 'if(how)how.textContent=p.how;'
  + 'var cli=root.querySelector("[data-lp-cli]");'
  + 'if(!cli&&how&&how.parentElement){cli=document.createElement("p");cli.setAttribute("data-lp-cli","1");cli.className="sand-lp-cli";'
  + 'how.parentElement.insertBefore(cli,how.nextSibling);}'
  + 'if(cli){cli.textContent="";'
  + 'if(p.id==="codex"||p.id==="claude-code"){try{window.desktop.agent.getInferenceRouter().then(function(r){'
  + 'var c=(r&&r.local&&r.local[p.id])||{};'
  + 'cli.textContent=c.authenticated?"\\u2713 Already signed in on this Mac":c.installed?"Installed, not signed in yet":"Not installed yet";'
  + '}).catch(function(){})}catch(_){}}}'
  + 'if(h.getAttribute("data-lp-title")===p.id)return;'
  + 'h.setAttribute("data-lp-title",p.id);h.textContent=p.title;'
  + 'var host=h.parentElement;if(!host)return;'
  + 'var own=host.querySelector("[data-lp-mark]");'
  + 'var mascot=null,kids=host.querySelectorAll("svg,img");'
  + 'for(var j=0;j<kids.length;j++){if(!kids[j].closest("[data-lp-mark]")){mascot=kids[j];break}}'
  + 'var swap=(p.id==="codex"||p.id==="claude-code");'
  + 'if(mascot)mascot.style.display=swap?"none":"";'
  + 'if(!swap){if(own)own.remove();return}'
  + 'if(!own){own=document.createElement("span");own.setAttribute("data-lp-mark","1");own.className="sand-lp-mark";'
  + '(mascot&&mascot.parentElement?mascot.parentElement:host).insertBefore(own,mascot||h)}'
  + 'own.style.color=p.accent;own.style.width="1em";own.style.fontSize=getComputedStyle(h).fontSize;'
  + 'own.innerHTML=p.svg;own.style.animation="none";void own.offsetWidth;own.style.animation=""};'
  + 'var close=function(){var s=document.querySelector(".sand-lp-scrim");if(s)s.remove();'
  + 'var r=document.querySelector(".sand-onboarding");if(r)r.setAttribute("data-lp-show","1")};'
  + 'var open=function(){if(document.querySelector(".sand-lp-scrim"))return;style();'
  +   'var scrim=document.createElement("div");scrim.className="sand-lp-scrim";'
  +   'scrim.addEventListener("mousedown",function(e){if(e.target===scrim&&picked())close()});'
  +   'var sheet=document.createElement("div");sheet.className="sand-lp-sheet";sheet.setAttribute("role","dialog");sheet.setAttribute("aria-label","Choose how to sign in");'
  +   'var h=document.createElement("p");h.className="sand-lp-h";h.textContent="How do you want to sign in?";'
  +   'var sub=document.createElement("p");sub.className="sand-lp-sub";sub.textContent="This decides who your account belongs to and where the work runs.";'
  +   'sheet.append(h,sub);'
  +   'var msg=document.createElement("p");msg.className="sand-lp-msg";msg.textContent="";'
  +   'var pick=cur;'
  +   'var rows=[];'
  +   'P.forEach(function(p){'
  +     'var b=document.createElement("button");b.type="button";b.className="sand-lp-opt";b.setAttribute("role","radio");b.style.setProperty("--a",p.accent);'
  +     'b.setAttribute("aria-checked",p.id===pick?"true":"false");'
  +     'b.innerHTML=\'<span class="sand-lp-ic">\'+p.svg+\'</span><span><span class="sand-lp-nm">\'+p.label+\'</span><span class="sand-lp-tg" style="display:block">\'+p.tag+"</span><span class=\\"sand-lp-tg\\" data-lp-state style=\\"display:none\\"></span></span>";'
  +     'b.addEventListener("click",function(){pick=p.id;rows.forEach(function(r){r.el.setAttribute("aria-checked",r.id===pick?"true":"false")});draw()});'
  +     'rows.push({id:p.id,el:b});sheet.appendChild(b);'
  +     'openRows=rows;'
  +   '});'
  +   'try{window.desktop.agent.getInferenceRouter().then(function(r){var l=(r&&r.local)||{};'
  +   'rows.forEach(function(row){var c=l[row.id];if(!c)return;'
  +   'var el=row.el.querySelector("[data-lp-state]");if(!el)return;'
  +   'var msg=c.authenticated?"\\u2713 Signed in on this Mac":c.installed?"Needs one sign-in in a terminal":"Not installed yet";'
  +   'el.textContent=msg;el.style.display="block";el.style.opacity=c.authenticated?".9":".6"})}).catch(function(){})}catch(_){}'
  +   'var extra=document.createElement("div");extra.className="sand-lp-extra";sheet.appendChild(extra);sheet.appendChild(msg);'
  +   'var foot=document.createElement("div");foot.className="sand-lp-foot";'
  +   'var cancel=document.createElement("button");cancel.type="button";cancel.className="sand-lp-btn";cancel.textContent="Cancel";cancel.style.display=picked()?"":"none";cancel.addEventListener("click",close);'
  +   'var use=document.createElement("button");use.type="button";use.className="sand-lp-btn";use.textContent="Use this";'
  +   'foot.append(cancel,use);sheet.appendChild(foot);'
  +   'var urlIn=null;'
  +   'var draw=function(){extra.replaceChildren();urlIn=null;'
  +     'if(pick!=="opengrok")return;'
  +     'urlIn=document.createElement("input");urlIn.className="sand-lp-in";urlIn.type="text";urlIn.placeholder="http://192.168.1.10:1447";urlIn.setAttribute("aria-label","OpenGrok server URL");'
  +     'extra.appendChild(urlIn);'
  +     'try{window.desktop.agent.getOpenGrokServer().then(function(r){if(r&&r.gatewayUrl&&urlIn)urlIn.value=r.gatewayUrl}).catch(function(){})}catch(_){}'
  +   '};'
  +   'use.addEventListener("click",function(){if(busy)return;busy=!0;use.disabled=!0;msg.textContent="Switching\\u2026";'
  +     'cur=pick;markPicked(!0);chrome(byId(pick));'
  +     'var a=window.desktop.agent;var done=function(){busy=!1;use.disabled=!1;cur=pick;markPicked(!0);chrome(byId(pick));close();mount()};'
  +     'var fail=function(e){busy=!1;use.disabled=!1;msg.textContent=String(e&&e.message||e)};'
  +     'if(pick==="opengrok"){var u=(urlIn&&urlIn.value||"").trim();if(!u){fail(new Error("Add your server URL first."));return}'
  +       'a.setOpenGrokServer(u).then(function(){return a.setBoxRuntime("opengrok")}).then(function(){try{localStorage.setItem(MODE_K,"1")}catch(_){}done()}).catch(fail);return}'
  +     'try{localStorage.removeItem(MODE_K);localStorage.removeItem("sand-cursor-login-skip")}catch(_){}'
  +     'a.setBoxRuntime("local-docker").catch(function(){}).then(function(){'
  +       'return a.setInferenceRouter?a.setInferenceRouter(pick):Promise.resolve()}).then(done).catch(fail);'
  +   '});'
  +   'draw();scrim.appendChild(sheet);document.body.appendChild(scrim);'
  +   'document.addEventListener("keydown",function esc(e){if(e.key==="Escape"){close();document.removeEventListener("keydown",esc)}});'
  + '};'
  // ---- mount the gear, keep the chrome in step ----
  + 'var BACK=G(\'<path d="M15 5l-7 7 7 7"/>\');'
  + 'var chose=!1;var picked=function(){return chose};'
  + 'try{self.__sandLoginPreview=function(id){'
  + 'var host=document.createElement("div");host.className="sand-onboarding";'
  + 'host.innerHTML="<div><svg width=\\"40\\" height=\\"40\\"></svg><h1>Grok Bot</h1>"'
  + '+"<p>Your team of always-on agents that you can give real work to.</p>"'
  + '+"<button type=\\"button\\">Sign in</button></div>";'
  + 'chrome(byId(id),host);'
  + 'return{id:id,page:host.getAttribute("data-lp-page"),'
  + 'accent:host.style.getPropertyValue("--lp-accent"),'
  + 'title:(host.querySelector("h1")||{}).textContent||null,'
  + 'lede:(host.querySelector("[data-lp-lede]")||{}).textContent||null,'
  + 'rule:!!host.querySelector("[data-lp-rule]"),'
  + 'how:(host.querySelector("[data-lp-how]")||{}).textContent||null,'
  + 'signIn:Array.from(host.querySelectorAll("button")).some(function(b){return /^Sign in/.test(b.textContent||"")})}'
  + '}}catch(_){}'
  + 'var markPicked=function(on){chose=!!on};'
  + 'var mount=function(){var root=document.querySelector(".sand-onboarding");if(!root)return;'
  + 'if(getComputedStyle(root).position==="static")root.style.position="relative";'
  + 'root.querySelectorAll("[data-login-skip]").forEach(function(n){n.remove()});'
  + 'if(!picked()){root.removeAttribute("data-lp-show");open();hideSplash();return}'
  + 'root.setAttribute("data-lp-show","1");hideSplash();'
  + 'if(!root.querySelector(".sand-lp-back")){style();'
  + 'var b=document.createElement("button");b.type="button";b.className="sand-lp-back";'
  + 'b.title="Choose a different provider";b.setAttribute("aria-label","Choose a different provider");b.innerHTML=BACK;'
  + 'b.addEventListener("click",function(){open()});root.appendChild(b)}'
  + 'if(cur)chrome(byId(cur))};'
  + 'var note=function(msg){try{var root=document.querySelector(".sand-onboarding");if(!root)return;'
  + 'var n=root.querySelector("[data-lp-note]");'
  + 'if(!n){n=document.createElement("p");n.setAttribute("data-lp-note","1");'
  + 'n.style.cssText="position:absolute;left:0;right:0;bottom:26px;margin:0;text-align:center;font-size:13px;opacity:.8";root.appendChild(n)}'
  + 'n.textContent=msg}catch(_){}};'
  + 'document.addEventListener("click",function(ev){'
  + 'var b=ev.target&&ev.target.closest?ev.target.closest("button"):null;if(!b)return;'
  + 'if(b.classList&&b.classList.contains("sand-lp-back"))return;'
  + 'if(b.closest&&b.closest(".sand-lp-sheet"))return;'
  + 'if(!/^Sign in/i.test((b.innerText||"").trim()))return;'
  + 'if(!cur||cur==="cursor")return;'
  + 'ev.preventDefault();ev.stopPropagation();'
  + 'var a=window.desktop&&window.desktop.agent;if(!a)return;'
  + 'if(cur==="opengrok"){a.getOpenGrokServer().then(function(r){var u=r&&r.gatewayUrl;'
  + 'if(!u){markPicked(!1);open();return}note("Opening your browser to sign in\\u2026");'
  + 'return a.signInToOpenGrokServer(u).then(function(res){'
  + 'note("Signed in"+(res&&res.email?" as "+res.email:"")+". Opening\\u2026");'
  + 'setTimeout(function(){location.reload()},600)})'
  + '}).catch(function(e){note(String(e&&e.message||e))});return}'
  + 'if(!a.startSubscriptionLogin){note("This provider cannot sign in from here yet.");return}'
  + 'var cliOf=function(r){var l=r&&r.local;return(l&&l[cur])||{}};'
  + 'var proceed=function(){try{localStorage.setItem("sand-cursor-login-skip","1")}catch(_){}'
  + 'if(a.skipCursorLoginWall)a.skipCursorLoginWall({provider:cur}).then(function(){location.reload()}).catch(function(){location.reload()});'
  + 'else location.reload()};'
  + 'var watch=function(tries){a.getInferenceRouter().then(function(r){var c=cliOf(r);'
  + 'if(c.authenticated){note("Signed in. Opening\\u2026");proceed();return}'
  + 'if(tries<=0){note("Still not signed in. Finish in the terminal, then press Sign in again.");return}'
  + 'setTimeout(function(){watch(tries-1)},2000)}).catch(function(){setTimeout(function(){watch(tries-1)},2000)})};'
  + 'a.getInferenceRouter().then(function(r){var c=cliOf(r);'
  + 'if(c.authenticated){note("Already signed in. Opening\\u2026");proceed();return}'
  + 'note(c.installed?"Opening a terminal to sign in\\u2026":"Opening a terminal to install it\\u2026");'
  + 'return a.startSubscriptionLogin(cur).then(function(){watch(60)})'
  + '}).catch(function(e){note(String(e&&e.message||e)+" \\u2014 try another provider.")})'
  + '},!0);'
  + 'var boot=function(){mount();read().then(function(id){cur=id||"cursor"}).catch(function(){cur="cursor"}).then(function(){ready=!0;'
  + 'if(openRows)openRows.forEach(function(r){r.el.setAttribute("aria-checked",r.id===cur?"true":"false")});'
  + 'mount()})};'
  + 'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();'
  + 'var relabel=function(){'
  + 'document.querySelectorAll("[role=menuitem]").forEach(function(mi){'
  + 'var t=(mi.textContent||"").trim();'
  + 'if(t!=="Sign in"||mi.getAttribute("data-lp-out"))return;'
  + 'if(document.querySelector(".sand-onboarding")||document.querySelector(".sand-lp-scrim"))return;'
  + 'mi.setAttribute("data-lp-out","1");'
  + 'var lbl=Array.from(mi.querySelectorAll("*")).filter(function(n){return n.childElementCount===0&&(n.textContent||"").trim()==="Sign in"}).pop()||mi;'
  + 'lbl.textContent="Log out";'
  + 'mi.addEventListener("click",function(ev){ev.preventDefault();ev.stopPropagation();ev.stopImmediatePropagation();'
  + 'try{localStorage.removeItem("sand-cursor-login-skip")}catch(_){}'
  + 'markPicked(!1);'
  + 'document.querySelectorAll(".sand-onboarding").forEach(function(n){n.removeAttribute("data-lp-show")});'
  + 'try{document.body.click()}catch(_){}'
  + 'setTimeout(open,60)},!0)})};'
  + 'relabel();new MutationObserver(relabel).observe(document.documentElement,{childList:!0,subtree:!0});'
  + 'new MutationObserver(function(){if(document.querySelector(".sand-onboarding"))mount()}).observe(document.documentElement,{childList:!0,subtree:!0});'
  + '}catch(_){}})();\n';

const A11Y_ANNOUNCE_HELPER = ';(()=>{try{'
  + 'var live=document.createElement("div");live.className="sand-a11y-announcer";'
  + 'live.setAttribute("role","status");live.setAttribute("aria-live","polite");live.setAttribute("aria-atomic","true");'
  + 'live.style.cssText="position:fixed;top:0;left:0;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(100%);white-space:nowrap";'
  + 'document.body.appendChild(live);'
  + 'var say=function(text){try{if(!text)return;live.textContent="";setTimeout(function(){live.textContent=text},60)}catch(_){}};'
  + 'self.__sandAnnounce=say;'
  + 'var QUIET_MS=1500,streaming=false,quiet=null,observed=null;'
  + 'var tail=function(){try{var rows=document.querySelectorAll(".sand-virtual-transcript .sand-transcript-row");var row=rows[rows.length-1];if(!row)return "";'
  + 'var t=(row.innerText||"").replace(/\\s+/g," ").replace(/\\s*\\d{1,2}:\\d{2}\\s*(AM|PM)?$/i,"").trim();'
  + 'return t.length>160?t.slice(0,160)+"\u2026":t}catch(_){return ""}};'
  // The assistant's reply arrives as text mutations inside the transcript. That
  // is the only dependable signal: data-pending marks a user message waiting to
  // be acknowledged, not a reply being written, and there is no streaming class.
  // The user's own message lands in the transcript exactly as a reply does, so
  // without this their send announces itself as the assistant replying. Asking
  // the last row who it belongs to is steadier than inspecting each mutation:
  // the changed node is often a wrapper around the row, not the row itself.
  + 'var lastRow=function(){var rows=document.querySelectorAll(".sand-virtual-transcript .sand-transcript-row");return rows[rows.length-1]||null};'
  + 'var mine=function(){var row=lastRow();return row!=null&&row.getAttribute("data-role")==="user"};'
  + 'var tick=function(){if(mine())return;'
  + 'if(!streaming){streaming=true;say("Assistant is replying")}'
  + 'clearTimeout(quiet);quiet=setTimeout(function(){streaming=false;say("Reply finished. "+tail())},QUIET_MS)};'
  + 'var isText=function(muts){for(var i=0;i<muts.length;i++){var m=muts[i];'
  + 'if(m.type==="characterData")return true;'
  + 'if(m.type==="childList"){for(var j=0;j<m.addedNodes.length;j++){var n=m.addedNodes[j];if(n.nodeType===3||(n.textContent||"").trim().length>0)return true}}}'
  + 'return false};'
  // Scoped to the scroller and to text only, so scrolling and the virtualizer
  // mounting rows do not read out as a reply.
  + 'var attach=function(){var sc=document.querySelector(".sand-virtual-transcript");if(!sc||sc===observed)return;observed=sc;'
  + 'try{new MutationObserver(function(muts){if(isText(muts))tick()}).observe(sc,{subtree:true,childList:true,characterData:true})}catch(_){}};'
  + 'attach();setInterval(attach,1500);'
  + '}catch(_){}})();\n';

// `s` is the ask in scope at this call site, carrying `action` and `target`.
// An empty return from the helper falls back to the original title, so an
// action this build does not name still prompts rather than showing nothing.
const LOCAL_TOOL_TITLE_BEFORE = 'hideBadge:!0,leading:Y,title:TLn,...U}';
const LOCAL_TOOL_TITLE_AFTER = 'hideBadge:!0,leading:Y,title:(self.__sandLocalToolAskTitle&&self.__sandLocalToolAskTitle(s.action)||TLn),...U}';

export function patchOriginalLocalToolAsk(source) {
  return replaceExactlyOnce(source, LOCAL_TOOL_TITLE_BEFORE, LOCAL_TOOL_TITLE_AFTER, "local tool ask title");
}

// First-layout reveal gate (0.29's hasRevealedFirstLayout). The transcript
// viewport node is recreated on every chat switch, so gating each newly-seen
// node's opacity to 0 for its first stable layout - then fading in - hides the
// open-time scroll/height settle. A hard failsafe timeout guarantees the node
// is never left invisible even if a frame callback is dropped.
// The General account card is written for a Cursor account and says "Not signed
// in / Sign In with Cursor" whenever there is not one - even when the person is
// signed in through Codex or Claude and the app is working perfectly. It now
// names whoever the current provider says you are, and offers to sign out of
// that rather than into Cursor.
const ACCOUNT_CARD_HELPER = ';(()=>{try{'
  + 'var t=document.createElement("style");t.textContent=".sand-agents-empty{display:none!important}";'
  + '(document.head||document.documentElement).appendChild(t);'
  + 'var LBL={codex:"Codex",\'claude-code\':"Claude",cursor:"Cursor",opengrok:"Open Grok"};'
  + 'var last=null;'
  + 'var paint=function(card,who){'
  +   'if(!card||card.getAttribute("data-lp-account")===who.key)return;'
  +   'card.setAttribute("data-lp-account",who.key);'
  +   'var texts=card.querySelectorAll("p,span,div");var set=0;'
  +   'for(var i=0;i<texts.length&&set<2;i++){var n=texts[i];if(n.children.length)continue;'
  +     'var t=(n.textContent||"").trim();'
  +     'if(!set&&/^(Not signed in|Signing in)$/.test(t)){n.textContent=who.title;set=1;continue}'
  +     'if(set===1&&/Cursor account|Finish signing in/.test(t)){n.textContent=who.sub;set=2}}'
  +   'var b=card.querySelector("button");'
  +   'if(b&&/sign in/i.test((b.textContent||""))){b.textContent="Sign out";'
  +     'if(!b.getAttribute("data-lp-signout")){b.setAttribute("data-lp-signout","1");'
  +     'b.addEventListener("click",function(ev){ev.preventDefault();ev.stopPropagation();'
  +       'try{localStorage.removeItem("sand-cursor-login-skip")}catch(_){}'
  +       'var a=window.desktop&&window.desktop.agent;'
  +       'if(a&&a.signOutOfOpenGrokServer)a.signOutOfOpenGrokServer().catch(function(){});'
  +       'setTimeout(function(){location.reload()},400)},!0)}}'
  + '};'
  + 'var ogPaint=function(card){'
  + 'var ns=card.querySelectorAll("p,span,div");'
  + 'for(var q=0;q<ns.length;q++){var e2=ns[q];if(e2.children.length)continue;'
  + 'var v=(e2.textContent||"").trim();'
  + 'if(v==="Cursor"||v==="Not signed in"||v==="Signing in"){e2.textContent="Open Grok";continue}'
  + 'if(v==="C")e2.textContent="O"}'
  + 'card.setAttribute("data-lp-account","opengrok")};'
  + 'var scan=function(){var card=document.querySelector(".sand-account");if(!card)return;'
  + 'try{if(localStorage.getItem("sand-opengrok-mode")==="1")ogPaint(card)}catch(_){}'
  +   'var a=window.desktop&&window.desktop.agent;if(!a)return;'
  +   'Promise.all([a.getInferenceRouter().catch(function(){return null}),'
  +     'a.getBoxRuntime().catch(function(){return null})]).then(function(r){'
  +     'var st=r[0]||{},box=r[1]||{};'
  +     'var prov=box.mode==="opengrok"?"opengrok":(st.provider||"cursor");'
  +     'if(prov==="opengrok"){ogPaint(card);return}if(prov==="cursor")return;'   // those have a real account card already
  +     'var cli=(st.local&&st.local[prov])||{};'
  +     'if(!cli.authenticated)return;'
  +     'paint(card,{key:prov,title:LBL[prov]||prov,sub:cli.prompt||("Signed in on this Mac")})'
  +   '}).catch(function(){})};'
  + 'scan();new MutationObserver(scan).observe(document.documentElement,{childList:!0,subtree:!0});'
  + '}catch(_){}})();\n';

const REVEAL_GATE_HELPER = ';(()=>{try{'
  + 'var last=null,scheduled=false;'
  + 'var gate=function(el){try{el.style.opacity="0";var done=false;var reveal=function(){if(done)return;done=true;el.style.transition="opacity .12s ease";el.style.opacity="1"};requestAnimationFrame(function(){requestAnimationFrame(reveal)});setTimeout(reveal,200)}catch(_){try{el.style.opacity="1"}catch(e){}}};'
  + 'var scan=function(){scheduled=false;var el=document.querySelector(".sand-virtual-transcript");if(el&&el!==last){last=el;gate(el)}};'
  // Coalesce all mutations in a frame into one scan so the virtualizer's
  // per-scroll row churn can't turn this observer into a hot path.
  + 'var trigger=function(){if(!scheduled){scheduled=true;requestAnimationFrame(scan)}};'
  + 'try{new MutationObserver(trigger).observe(document.documentElement,{childList:true,subtree:true})}catch(_){}scan()}catch(_){}})();\n';

// The attachment frame's size decision: explicit row dims win, then the
// resolved media's dims, then (new) the renderer store - so a once-seen
// image or video gets an exact-size frame and skeleton on every later
// mount, box agents included. Only when all three miss does the 200x200
// square fallback engage.
const DIMS_CHAIN_BEFORE = 'G=v==="tile",Y=!G,U=x?o??q?.width??null:o??W,ee=x?l??q?.height??null:l??H;let te;';
// Store-first precedence: the renderer store records what the browser
// actually rendered (orientation-corrected), so once an entry exists the
// placeholder and the resolved image build the exact same box - sniffed
// row/resolver dims can never resize the frame at resolve time.
const DIMS_CHAIN_AFTER = 'G=v==="tile",Y=!G,sdQ=window.__sandMediaMeta?window.__sandMediaMeta.get(b):null,U=x?sdQ?.w??o??q?.width??null:sdQ?.w??o??W??null,ee=x?sdQ?.h??o??q?.height??null:sdQ?.h??o??H??null;let te;';

// Known-size frames carry the blur-up thumbnail as a CSS custom property;
// injected style paints it behind the loading image in place of the grey
// skeleton shimmer.
// The frame's final style merges class styles with j for BOTH branches here;
// injecting the blur-up custom property at this single site covers sized
// frames and the style-less tile variant alike.
const FRAME_STYLE_MERGE_BEFORE = 'e[106]!==j||e[107]!==se.style?(ae=se.style==null?j:{...se.style,...j},e[106]=j,e[107]=se.style,e[108]=ae):ae=e[108];';
// Blur-up thumbnails are sunset for images (skeletons are simpler and the
// perf delta is negligible); dims still merge via sdQ upstream, and video
// posters keep using captured thumbs.
const FRAME_STYLE_MERGE_AFTER = 'e[106]!==j||e[107]!==se.style?(ae={...(se.style==null?null:se.style),...(j==null?null:j)},e[106]=j,e[107]=se.style,e[108]=ae):ae=e[108];';

// Canvas capture across the sand-media scheme needs a CORS-mode request
// (paired with the access-control-allow-origin header the protocol now
// sends); other origins keep plain requests so external images still load.
// The agent context menu's last section is [Hide from sidebar, Delete];
// slot a native It.Item between them so Clear media cache lives in the
// official menu instead of replacing it.
const MENU_CLEAR_BEFORE = 'let te;e[59]!==U||e[60]!==ee?(te=p.jsxs(It.Section,{children:[U,ee]}),e[59]=U,e[60]=ee,e[61]=te):te=e[61];';
const MENU_CLEAR_AFTER = 'let te;const sandCC=p.jsx(It.Item,{leading:p.jsx(bt,{name:"refresh",size:"base"}),onSelect:()=>{try{window.__sandMediaMeta&&window.__sandMediaMeta.clearAgent(t.id)}catch(_){}try{window.desktop&&window.desktop.clearAgentMediaCache&&window.desktop.clearAgentMediaCache(t.id).catch(()=>{})}catch(_){}},children:"Clear media cache"});e[59]!==U||e[60]!==ee?(te=p.jsxs(It.Section,{children:[U,sandCC,ee]}),e[59]=U,e[60]=ee,e[61]=te):te=e[61];';

const VIDEO_THUMB_BEFORE = 'd=p.jsx("video",{"aria-hidden":!0,className:c,muted:!0,onLoadedMetadata:u,preload:"metadata",src:t})';
const VIDEO_THUMB_AFTER = 'd=(()=>{var sm=window.__sandMediaMeta&&t?window.__sandMediaMeta.get(t):null;return sm&&sm.thumb?p.jsx("img",{"aria-hidden":!0,className:c,draggable:!1,src:sm.thumb,style:{objectFit:"cover",width:"100%",height:"100%"}}):p.jsx("video",{"aria-hidden":!0,className:c,crossOrigin:t&&t.startsWith("sand-media:")?"anonymous":void 0,muted:!0,onLoadedMetadata:u,preload:"metadata",src:t})})()';


// Hover-menu Copy message ID: mCn has the entry in scope (t.id), so a third
// native item beside Start a thread / Copy copies the id for debugging and
// cross-referencing transcript rows.
// Message deep links: rows carry their entry id so the consumer can find and
// scroll to a message; the hover menu offers a shareable opengrok:// URL.
const ROW_ENTRY_ID_BEFORE = '"data-index":Nt.transcriptIndex,"data-pending":Ft.isPending||void 0,"data-role":Ft.role,"data-row-key":Nt.key,ref:nQ(Nt)';
const ROW_ENTRY_ID_AFTER = '"data-entry-id":vs!=null?vs.id:void 0,"data-entry-ids":Yt.kind==="attachment-group"?Yt.entries.map(function(sdEn){return sdEn.id}).join(" "):void 0,"data-index":Nt.transcriptIndex,"data-pending":Ft.isPending||void 0,"data-role":Ft.role,"data-row-key":Nt.key,ref:nQ(Nt)';

const MENU_COPY_ID_BEFORE = 'let lt;e[107]!==tt||e[108]!==ct?(lt=p.jsxs(It.Content,{"aria-label":"More message actions",minWidth:200,ref:A,size:"md",children:[tt,ct]}),e[107]=tt,e[108]=ct,e[109]=lt):lt=e[109];';
const MENU_COPY_ID_AFTER = 'const sandCID=p.jsx(It.Item,{leading:p.jsx(bt,{name:"copy",size:"base"}),onSelect:()=>{try{navigator.clipboard.writeText(String(t&&t.id||""))}catch(_e){}_()},children:"Copy message ID"});const sandCURL=p.jsx(It.Item,{leading:p.jsx(bt,{name:"link",size:"base"}),onSelect:()=>{try{var ag=(t&&(t.agentId||t.agent))||(self.__sandCurrentAgent?self.__sandCurrentAgent():"")||"";var mid=String(t&&t.id||"");var row=document.querySelector("[data-entry-id="+JSON.stringify(mid)+"]");var ih=row?row.getAttribute("data-index"):null;navigator.clipboard.writeText("opengrok://app/v1/message?agent="+encodeURIComponent(ag)+"&id="+encodeURIComponent(mid)+(ih?"&i="+ih:""))}catch(_e){}_()},children:"Copy message URL"});const sandBust=p.jsx(It.Item,{leading:p.jsx(bt,{name:"refresh",size:"base"}),onSelect:()=>{try{var row=document.querySelector("[data-entry-id=\'"+String(t&&t.id||"")+"\']");var n=0;if(row&&self.__sandMediaMeta&&self.__sandMediaMeta.clearKey){row.querySelectorAll("img,video").forEach(function(m){var src=m.currentSrc||m.src;if(src&&src.indexOf("data:")!==0)n+=self.__sandMediaMeta.clearKey(src)})}console.log("[sand] busted media cache entries:",n)}catch(_e){}_()},children:"Clear media cache (message)"});const sandSel=p.jsx(It.Item,{leading:p.jsx(bt,{name:"check",size:"base"}),onSelect:()=>{try{window.__sandSelect&&window.__sandSelect.enter(String(t&&t.id||""))}catch(_e){}_()},children:"Select messages"});let lt;e[107]!==tt||e[108]!==ct?(lt=p.jsxs(It.Content,{"aria-label":"More message actions",minWidth:200,ref:A,size:"md",children:[tt,ct,sandCID,sandCURL,sandBust,sandSel]}),e[107]=tt,e[108]=ct,e[109]=lt):lt=e[109];';

// Avatar eye placement (0.29 parity). The live mark controller seeds its
// committed shape from the prop, but sidebar marks mount before the roster
// resolves the real shape: the shape prop arrives later, the morph starts at
// progress 0 (blending from the default blob), and on a paused mark the rAF
// loop that would advance the morph is stopped - so the eyes freeze with the
// blob's face and blob span clamp inside the REAL shape's clip-path. On the
// 3-sided wedge the right eye sits outside the wedge and is clipped
// invisible. Fix: when the loop is stopped, commit shape changes instantly
// (morph progress 1 -> the shape's own fitted face and span clamp, matching
// 0.29's steady state); a running loop keeps the animated morph. The settled
// -stop reset also commits the live shape before its final render.
const AVATAR_MORPH_SNAP_BEFORE = 'Ce=R.current,Je.x=0,Je.v=0,Je.t=1,ts()}const bn=K2(zn(Je.x,0,1))';
const AVATAR_MORPH_SNAP_AFTER = 'Ce=R.current,Je.x=ss===0?1:0,Je.v=0,Je.t=1,ts()}const bn=K2(zn(Je.x,0,1))';
// The loop only restarts on unpause; a shape prop that arrives after the
// roster resolves (our async seeding) never wakes it. Wake on shape change
// too - the woken frame either animates the morph or, if it settles
// immediately, the reset-commit above snaps to the live shape.
const AVATAR_WAKE_BEFORE = 'S.useEffect(()=>{W.current=d,d||H.current()},[d]);';
const AVATAR_WAKE_AFTER = 'S.useEffect(()=>{W.current=d,d||H.current()},[d]);S.useEffect(()=>{H.current()},[s]);';
const AVATAR_RESET_COMMIT_BEFORE = 'ae=[u3[0][0],u3[0][1]],ce=ae,Se=0,xe.x=1,xe.v=0,xe.t=1,mn(0),ss=0';
const AVATAR_RESET_COMMIT_AFTER = 'ae=[u3[0][0],u3[0][1]],ce=ae,Se=0,xe.x=1,xe.v=0,xe.t=1,Ce=R.current,Ie=Jo[Ce].ring,qe=Jo[Ce].face,we=Jo[Ce].tiltScale,Pe=Jo[Ce].beltRadius,Je.x=1,Je.v=0,Je.t=1,mn(0),ss=0';

export function patchOriginalAvatarEyes(source) {
  let patched = replaceExactlyOnce(source, AVATAR_MORPH_SNAP_BEFORE, AVATAR_MORPH_SNAP_AFTER, "avatar morph snap");
  patched = replaceExactlyOnce(patched, AVATAR_RESET_COMMIT_BEFORE, AVATAR_RESET_COMMIT_AFTER, "avatar reset commit");
  patched = replaceExactlyOnce(patched, AVATAR_WAKE_BEFORE, AVATAR_WAKE_AFTER, "avatar shape wake");
  patched = replaceExactlyOnce(patched, MENU_COPY_ID_BEFORE, MENU_COPY_ID_AFTER, "menu copy message id");
  patched = replaceExactlyOnce(patched, ROW_ENTRY_ID_BEFORE, ROW_ENTRY_ID_AFTER, "row entry ids");
  return patched;
}

// Wire the math kit into both react-markdown surfaces: append the remark
// plugins, register the sand-math component (KaTeX MathML via innerHTML),
// and run the \(...\)/\[...\] preprocessor over the markdown source.
const MATH_COMPONENT = '"sand-math":n=>p.jsx("span",{className:"sand-math"+(n.display==="true"?" sand-math-display":""),dangerouslySetInnerHTML:{__html:self.__sandMathKit?self.__sandMathKit.render(n.tex,n.display==="true"):""}})';
const MATH_PLUGINS_A_BEFORE = 'Swn=[[wrt,{singleTilde:!1}],...r1t],xwn=[...i1t,...V7n]';
const MATH_PLUGINS_A_AFTER = 'Swn=[[wrt,{singleTilde:!1}],...r1t,...(self.__sandMathKit?self.__sandMathKit.remarkPlugins:[])],xwn=[...i1t,...V7n]';
const MATH_PLUGINS_B_BEFORE = 'kPn=[[wrt,{singleTilde:!1}],...r1t],wPn=';
const MATH_PLUGINS_B_AFTER = 'kPn=[[wrt,{singleTilde:!1}],...r1t,...(self.__sandMathKit?self.__sandMathKit.remarkPlugins:[])],wPn=';
const MATH_COMPONENTS_A_BEFORE = 'const Cwn=Ewn();';
const MATH_COMPONENTS_A_AFTER = `const Cwn={...Ewn(),${MATH_COMPONENT}};`;
const MATH_COMPONENTS_B_BEFORE = 'NPn={a({node:n,children:e,href:t,...';
const MATH_COMPONENTS_B_AFTER = `NPn={${MATH_COMPONENT},a({node:n,children:e,href:t,...`;
const MATH_PRE_A_BEFORE = ',urlTransform:p1t,children:t})';
const MATH_PRE_A_AFTER = ',urlTransform:p1t,children:self.__sandMathKit?self.__sandMathKit.pre(t):t})';
const MATH_PRE_B_BEFORE = ',urlTransform:p1t,children:n})';
// User bubbles are plain text (BPn); mathify gives them a math-only pass so
// pasted KaTeX renders in the sender's bubble too, everything else literal.
const MATH_USER_BUBBLE_BEFORE = 'k=gpt(x,r,"c"),e[7]=s';
const MATH_USER_BUBBLE_AFTER = 'k=(self.__sandMathKit&&self.__sandMathKit.mathText?self.__sandMathKit.mathText(x,r,"c",gpt,p.jsx):gpt(x,r,"c")),e[7]=s';
// Composer messages carry richText (TipTap), rendered node-by-node in jPn;
// wrap its text case too, skipping code-marked text.
const MATH_RICH_TEXT_BEFORE = 'c=i?l:o?ppt(l,t,e):gpt(l,t,e);return RPn(c,n.marks,e)';
// c is const in jPn - transform inside the RPn call, never reassign.
const MATH_RICH_TEXT_AFTER = 'c=i?l:o?ppt(l,t,e):(self.__sandMathKit&&self.__sandMathKit.mathText?self.__sandMathKit.mathText(l,t,e,gpt,p.jsx):gpt(l,t,e));return RPn(c,n.marks,e)';
const MATH_PRE_B_AFTER = ',urlTransform:p1t,children:self.__sandMathKit?self.__sandMathKit.pre(n):n})';

export function patchOriginalMathPipeline(source) {
  let patched = replaceExactlyOnce(source, MATH_PLUGINS_A_BEFORE, MATH_PLUGINS_A_AFTER, "math remark plugins A");
  patched = replaceExactlyOnce(patched, MATH_PLUGINS_B_BEFORE, MATH_PLUGINS_B_AFTER, "math remark plugins B");
  patched = replaceExactlyOnce(patched, MATH_COMPONENTS_A_BEFORE, MATH_COMPONENTS_A_AFTER, "math component A");
  patched = replaceExactlyOnce(patched, MATH_COMPONENTS_B_BEFORE, MATH_COMPONENTS_B_AFTER, "math component B");
  patched = replaceExactlyOnce(patched, MATH_PRE_A_BEFORE, MATH_PRE_A_AFTER, "math preprocess A");
  patched = replaceExactlyOnce(patched, MATH_PRE_B_BEFORE, MATH_PRE_B_AFTER, "math preprocess B");
  patched = replaceExactlyOnce(patched, MATH_USER_BUBBLE_BEFORE, MATH_USER_BUBBLE_AFTER, "math user bubble");
  patched = replaceExactlyOnce(patched, MATH_RICH_TEXT_BEFORE, MATH_RICH_TEXT_AFTER, "math rich text");
  return patched;
}

// Exact row-height estimates for cached media (the zero-jump fix). iAn() is
// the chat-plane engine's row estimator: it receives the full row object, so
// for single media entries we consult the sandMediaMeta store (synchronous)
// through __sandMediaEstimate and return the same min(200, naturalH) the
// rendered tile uses - estimate == measured means the settle pass has nothing
// to correct and rows below never move. Multi-image groups are CSS-locked to
// 200px by TILE_CROP_STYLE regardless of contents, so their stock 192
// estimate (tAn) becomes the constant 200. Text rows keep the stock
// placeholder + live measurement: text reflows with viewport width and must
// never be height-predicted from a cache.
const ROW_ESTIMATE_BEFORE =
  'function iAn(n,e){switch(n.kind){case"entry":return[Fie(qve),The(dIn(n.entry),rAn(n.entry),e)];case"attachment-group":return[The(tAn,!1,e)];';
const ROW_ESTIMATE_AFTER =
  'function iAn(n,e){switch(n.kind){case"entry":return[Fie(qve),The((self.__sandTextHeights?self.__sandTextHeights.est(n.entry):null)??(self.__sandMediaEstimate?self.__sandMediaEstimate(n.entry):null)??dIn(n.entry),rAn(n.entry),e)];case"attachment-group":return[The(200,!1,e)];';

export function patchOriginalRowEstimator(source) {
  return replaceExactlyOnce(source, ROW_ESTIMATE_BEFORE, ROW_ESTIMATE_AFTER, "row height estimator");
}

// Device-local tombstones: the transcript row builder filters hidden entries
// before grouping, so a "deleted" message on a remote-box agent (whose store
// we cannot touch - it answers through Cursor's own in-box gateway) simply
// never becomes a row on this device.
const ROW_TOMBSTONE_BEFORE =
  'function npt(n,{threadRootId:e=null,unreadBoundaryAt:t=null,isTimestampOrdered:s=!1}={}){';
const ROW_TOMBSTONE_AFTER =
  'function npt(n,{threadRootId:e=null,unreadBoundaryAt:t=null,isTimestampOrdered:s=!1}={}){self.__sandTombstones&&self.__sandTombstones.size()&&(n=self.__sandTombstones.filter(n));';

export function patchOriginalRowTombstones(source) {
  return replaceExactlyOnce(source, ROW_TOMBSTONE_BEFORE, ROW_TOMBSTONE_AFTER, "row tombstone filter");
}

// Expose the engine's own row navigation (the find-in-chat teleport) so the
// deep-link consumer can jump straight to a message instead of sweeping the
// virtualized transcript from the top. `ne` is the app's memoized
// key -> navigate closure (B maps keys to row base signatures, E is the
// plane engine); republishing it on every render keeps the global fresh
// across chat switches. Engine-side it is a smooth centered navigate with a
// bounded watchdog - offsets come from the engine's shelf math, so it works
// for rows that were never mounted.
const NAV_EXPOSE_BEFORE = ',e[70]=E,e[71]=B,e[72]=ne):ne=e[72],';
const NAV_EXPOSE_AFTER = ',e[70]=E,e[71]=B,e[72]=ne):ne=e[72],self.__sandNavToRow=ne,';

// Gallery planning reads sizes from the in-memory resolver, which is empty
// until each image resolves - so a row that plans its height from those sizes
// starts at the 192 default and shrinks when the pictures land. Feeding the
// persistent dims store in as the fallback makes the plan correct on first
// paint, which is what keeps the row height stable (and equal to what the
// estimator predicted) now that the height is no longer forced to 200.
const GALLERY_SIZES_BEFORE =
  'const o=n.peek(i);if(o?.status!=="ready")return null;const{width:l,height:c}=o;return l==null||c==null?yTe(i):{width:l,height:c}';
const GALLERY_SIZES_AFTER =
  'const sdMM=self.__sandMediaMeta?self.__sandMediaMeta.get(i):null,sdF=sdMM&&sdMM.w>0?{width:sdMM.w,height:sdMM.h}:null;const o=n.peek(i);if(o?.status!=="ready")return sdF;const{width:l,height:c}=o;return l==null||c==null?(yTe(i)??sdF):{width:l,height:c}';

export function patchOriginalGallerySizes(source) {
  return replaceExactlyOnce(source, GALLERY_SIZES_BEFORE, GALLERY_SIZES_AFTER, "gallery cached sizes");
}

export function patchOriginalRowNavigate(source) {
  return replaceExactlyOnce(source, NAV_EXPOSE_BEFORE, NAV_EXPOSE_AFTER, "row navigate expose");
}

// Jump-loading (the Slack feel) without touching the replica state machine:
// expose the transcript store (fVn instance - its public loadOlder() pulls an
// older page with NO scrolling, exactly what the app's own search-reveal
// chase uses), so the deep-link consumer can stream history in place and
// teleport the moment the target enters the window. The two constants widen
// the pipes: older pages go 100 -> 400 entries per fetch (host clamps at
// 5000) and the app's own reveal chase gets 40 pages instead of 20. The
// synthetic-snapshot route was investigated and rejected: installing a
// mid-history window desyncs the live replica (acceptedSequence) and
// poisons resync, persistence, unread and bottom-pin state.
const TRANSCRIPT_STORE_EXPOSE_BEFORE = 'H=ee;const te=Y$n({source:n.source,';
const TRANSCRIPT_STORE_EXPOSE_AFTER = 'H=ee;self.__sandTranscript=ee;const te=Y$n({source:n.source,';
const OLDER_PAGE_LIMIT_BEFORE = 'const uVn=512,dVn=100,bKe=200,X0t=500,TKe=1e3';
const OLDER_PAGE_LIMIT_AFTER = 'const uVn=512,dVn=400,bKe=200,X0t=500,TKe=1e3';
const CHASE_DEPTH_BEFORE = 'const kOn=20,wOn=3e4;';
const CHASE_DEPTH_AFTER = 'const kOn=40,wOn=3e4;';

export function patchOriginalJumpLoad(source) {
  let patched = replaceExactlyOnce(source, TRANSCRIPT_STORE_EXPOSE_BEFORE, TRANSCRIPT_STORE_EXPOSE_AFTER, "transcript store expose");
  patched = replaceExactlyOnce(patched, OLDER_PAGE_LIMIT_BEFORE, OLDER_PAGE_LIMIT_AFTER, "older page limit");
  return replaceExactlyOnce(patched, CHASE_DEPTH_BEFORE, CHASE_DEPTH_AFTER, "reveal chase depth");
}

export function patchOriginalMediaMeta(source) {
  let patched = replaceExactlyOnce(source, DIMS_CHAIN_BEFORE, DIMS_CHAIN_AFTER, "media meta dims chain");
  patched = replaceExactlyOnce(patched, FRAME_STYLE_MERGE_BEFORE, FRAME_STYLE_MERGE_AFTER, "frame blur thumb");
  patched = replaceExactlyOnce(patched, VIDEO_THUMB_BEFORE, VIDEO_THUMB_AFTER, "video thumb cors");
  patched = replaceExactlyOnce(patched, MENU_CLEAR_BEFORE, MENU_CLEAR_AFTER, "agent menu clear cache");
  patched = patchOriginalMathPipeline(patched);
  patched = patchOriginalAvatarEyes(patched);
  patched = patchOriginalRowEstimator(patched);
  patched = patchOriginalRowTombstones(patched);
  patched = patchOriginalRowNavigate(patched);
  patched = patchOriginalGallerySizes(patched);
  patched = patchOriginalJumpLoad(patched);
  patched = patchOriginalLocalToolAsk(patched);
  return KATEX_BUNDLE_PREPEND + MEDIA_META_HELPER + JUMP_PILL_HELPER + REVEAL_GATE_HELPER + DRAFTS_HELPER + MEDIA_DEBUG_HELPER + DEEPLINK_MSG_HELPER + SELECT_MODE_HELPER + LOCAL_TOOL_ASK_HELPER + A11Y_ANNOUNCE_HELPER + OPENGROK_MODE_HELPER + LOGIN_PROVIDER_HELPER + ACCOUNT_CARD_HELPER + patched;
}


export function patchOriginalScrollInput(source) {
  let patched = replaceExactlyOnce(source, WHEEL_PEEK_BEFORE, WHEEL_PEEK_AFTER, "passive wheel peek");
  patched = replaceExactlyOnce(patched, IMG_FADE_BEFORE, IMG_FADE_AFTER, "async image decode");
  return replaceExactlyOnce(patched, IMG_THUMB_BEFORE, IMG_THUMB_AFTER, "async thumb decode");
}

// The transcript keeps only 6 rows beyond the viewport mounted, so scrolling
// one screen away unmounts images and returning replays the skeleton + async
// reload. Trade a few tens of MB of DOM/decoded tiles for ±several screens of
// mounted context; grey boxes then only appear on long jumps.
const OVERSCAN_BEFORE = "IAn=6,AAn=2e3";
const OVERSCAN_AFTER = "IAn=24,AAn=2e3";

export function patchOriginalOverscan(source) {
  return replaceExactlyOnce(source, OVERSCAN_BEFORE, OVERSCAN_AFTER, "transcript overscan");
}

export function patchOriginalSettingsRegistry(source) {
  const patched = replaceExactlyOnce(source, REGISTRY_BEFORE, REGISTRY_AFTER, "settings registry");
  return replaceExactlyOnce(patched, USAGE_TAB_FILTER_BEFORE, USAGE_TAB_FILTER_AFTER, "usage tab visibility");
}

export const COMPOSER_ATTACH_REPLACEMENTS = [
  [
    'function D9n(n){return n.name.length>0?n.name:n.type.startsWith("image/")||mAe(n.name)?"image.png":"file"}',
    'function D9n(n){const e=xft(n.name);return e.length>0?e:n.type.startsWith("image/")||mAe(n.name)?"image.png":"file"}',
    "composer attach leaf name",
  ],
  [
    // Also re-encode large images to 2048px WebP q80 in the composer: canvas
    // is the only WebP encoder in the stack, and shrinking at attach time
    // makes storage, box upload, vision payloads, and tiles all small.
    "const o=D9n(i),l=async()=>{const c=new Uint8Array(await i.arrayBuffer());return e(o,c)}",
    'const o=D9n(i),l=async()=>{let c=new Uint8Array(0),oo=o;try{const u=await i.arrayBuffer();if(u.byteLength>0)c=new Uint8Array(u)}catch{}try{if(c.byteLength>1048576&&/^image\\/(png|jpe?g|webp)$/.test(i.type)){const bm=await createImageBitmap(new Blob([c],{type:i.type}));const sc=Math.min(1,2048/Math.max(bm.width,bm.height));const cv=new OffscreenCanvas(Math.max(1,Math.round(bm.width*sc)),Math.max(1,Math.round(bm.height*sc)));cv.getContext("2d").drawImage(bm,0,0,cv.width,cv.height);bm.close();const bl=await cv.convertToBlob({type:"image/webp",quality:i.type==="image/png"?1:.85});if(bl&&bl.size>0&&bl.size<c.byteLength){c=new Uint8Array(await bl.arrayBuffer());oo=oo.replace(/\\.[A-Za-z0-9]+$/,"")+".webp"}}}catch{}return e(oo,c,typeof i.path=="string"?i.path:void 0)}',
    "composer attach keep drop path",
  ],
  [
    "F9n(Te,(we,Pe)=>b.stageAttachmentBytes({filename:we,bytes:Pe}))",
    // Official 0.29 still sends {filename, bytes: Uint8Array}. The 0.18 RPC
    // client then unpacks e.filename/e.bytes — bytesBase64-only objects arrive
    // at preload as (name, undefined) and stage as "couldn't be attached".
    'F9n(Te,(we,Pe,qe)=>b.stageAttachmentBytes({filename:we,bytes:Pe,bytesBase64:(()=>{try{let n="";for(let e=0;e<Pe.length;e+=8192)n+=String.fromCharCode.apply(null,Pe.subarray(e,e+8192));return btoa(n)}catch{return void 0}})(),...(typeof qe=="string"&&qe.startsWith("/")?{sourcePath:qe}:{})}))',
    "composer attach json-safe bytes",
  ],
  [
    "n.stageAttachmentBytes(e.filename,e.bytes)",
    "n.stageAttachmentBytes(e)",
    "composer attach rpc forward request object",
  ],
];

export function patchOriginalComposerAttach(source) {
  let patched = source;
  for (const [before, after, label] of COMPOSER_ATTACH_REPLACEMENTS) {
    patched = replaceExactlyOnce(patched, before, after, label);
  }
  return patched;
}

export function patchOriginalLoginWall(source) {
  let patched = source;
  for (const [before, after, label] of LOGIN_WALL_REPLACEMENTS) {
    patched = replaceExactlyOnce(patched, before, after, label);
  }
  return patched;
}

const VIEW_LOAD_FALLBACK_BEFORE = 'function rPt(n){const e=he.c(3),{retry:t}=n;let s;e[0]===Symbol.for("react.memo_cache_sentinel")?(s=p.jsx("p",{children:"This view failed to load."}),e[0]=s):s=e[0];let r;return e[1]!==t?(r=p.jsxs("div",{role:"alert",children:[s,p.jsx("button",{type:"button",onClick:t,children:"Retry"})]}),e[1]=t,e[2]=r):r=e[2],r}';
const VIEW_LOAD_FALLBACK_AFTER = 'function rPt(n){const t=n&&n.retry;const[gone,setGone]=he.useState?[!1,function(){}]:[!1,function(){}];p.useEffect(function(){if(typeof t!=="function")return;var once=setTimeout(function(){try{t()}catch(_){}} ,1200);return function(){clearTimeout(once)}},[t]);return p.jsxs("div",{role:"status","aria-live":"polite",className:"sand-9f619 sand-10l6tqk sand-k6ci0l sand-191j7n5 sand-1c42kn3 sand-78zum5 sand-6s0dn4 sand-167g77z sand-96k8nx sand-nuq7ks sand-dvlbce sand-f18ygs sand-mkeg23 sand-1y0btm7 sand-hpnuu7 sand-1ct8sxb sand-bovzr6 sand-jyw3bf sand-treaks sand-pmgbkh sand-settings-toast",style:{position:"fixed",left:"50%",bottom:24,transform:"translateX(-50%)",zIndex:2147483646,display:"flex",alignItems:"center",gap:10},children:[p.jsx("span",{className:"sand-1iyjqo2 sand-euugli",children:"Couldn\'t open that screen."}),typeof t==="function"?p.jsx("button",{type:"button",onClick:t,style:{font:"inherit",fontSize:"12.5px",padding:"4px 10px",borderRadius:8,cursor:"pointer",border:"1px solid rgba(128,128,128,.35)",background:"rgba(128,128,128,.12)",color:"inherit"},children:"Try again"}):null]})}';

export function patchOriginalViewFallback(source) {
  return replaceExactlyOnce(source, VIEW_LOAD_FALLBACK_BEFORE, VIEW_LOAD_FALLBACK_AFTER, "lazy-view error toast");
}

/**
 * The placeholder shown where a computer's screen would be.
 *
 * It falls through to "Booting up the computer" for every state it has no
 * better word for, including a box that is up and simply has no screen. The
 * view already holds the box status, so the message can be chosen from it.
 */
/**
 * The composer's send, when it has nothing to send to.
 *
 * It returns silently: the button is enabled, the click lands, the typed text
 * stays in the box, and the message is never delivered. Watched live, a click
 * vanished and the identical click worked minutes later. Say so instead.
 */
/**
 * The expanded computer view, which had a word only for a local computer.
 *
 * For a remote box it passed no message and set the busy flag, so the
 * placeholder fell through to "Booting up the computer" and stayed there. The
 * view holds the box status, so the same message the strip uses applies here.
 *
 * Opening this view also wakes a stopped box. Someone opening their computer
 * is asking to use it; being told to go and type a message at it instead, by a
 * panel already holding the function that wakes it, is a poor answer.
 */
export function patchOriginalExpandedPlaceholder(source) {
  return replaceExactlyOnce(
    source,
    '...d.phase==="local"?{emptyMessage:ZOn}:{},isEmptyLoading:d.phase!=="local"',
    '...RBoxOpenPlaceholder(d,ZOn)',
    "expanded computer placeholder",
  );
}

export function patchOriginalSilentSend(source) {
  return replaceExactlyOnce(
    source,
    "if(we==null)return;const Pe=_",
    "if(we==null){RSendNotDelivered();return}const Pe=_",
    "silent send bail",
  );
}

export function patchOriginalComputerPlaceholder(source) {
  source = replaceExactlyOnce(
    source,
    "This agent runs on your machine. There's no separate desktop to stream.",
    "This computer has no graphical screen. It runs shell commands and files for this bot.",
    "headless computer copy",
  );
  return replaceExactlyOnce(
    source,
    "emptyMessage:void 0,isEmptyLoading:A,pullPercent:e.pullPercent",
    "emptyMessage:RBoxEmptyMessage(e),isEmptyLoading:A,pullPercent:e.pullPercent",
    "computer placeholder message",
  );
}

export function patchOriginalMainChrome(source) {
  if (source.includes("function RInstallFirstRunLogins()")) {
    throw new Error("Original renderer main chrome is already patched.");
  }
  if (containsUnquotedCodexIdentifier(MAIN_CHROME_SOURCE)) {
    throw new SyntaxError("Router renderer patch must quote the string 'codex' (or \"codex\"). An unquoted codex identifier breaks npm run package.");
  }
  return `${source}\n${MAIN_CHROME_SOURCE}`;
}

const EXECUTION_ROW_ANCHOR='const De="Execution on Local Computer",ia="Let the assistant open files and run tasks on your computer. Auto-review still checks everything first.";function da(){';

export function patchOriginalSettingsPanel(source) {
  if (containsUnquotedCodexIdentifier(COMPONENT_SOURCE)) {
    throw new SyntaxError("Router renderer patch must quote the string 'codex' (or \"codex\"). An unquoted codex identifier breaks npm run package.");
  }
  let patched = replaceExactlyOnce(source, COMPONENT_ANCHOR, `${COMPONENT_SOURCE}${COMPONENT_ANCHOR}`, "component insertion");
  patched = replaceExactlyOnce(patched, GENERAL_BEFORE, GENERAL_AFTER, "Router panel switch");
  patched = replaceExactlyOnce(patched, USAGE_BEFORE, USAGE_AFTER, "Usage panel switch");
  // The machine execution permission is set in one place only - Settings >
  // Computer > This computer. This General-tab twin let the two drift apart on
  // screen (the user hit exactly that: General said Never while Computer said
  // Ask), and the latest Grok Bot deleted its copy too. The row is one
  // self-contained component, so it is excised by making it render nothing.
  patched = replaceExactlyOnce(
    patched,
    EXECUTION_ROW_ANCHOR,
    `${EXECUTION_ROW_ANCHOR}return null;`,
    "General-tab execution row excision",
  );
  return patched;
}

export async function applyOriginalRendererRouterPatch({ stageRoot }) {
  const assetsRoot = path.join(stageRoot, "dist", "renderer", "assets");
  const registryCandidates = [];
  const panelCandidates = [];
  for (const name of await readdir(assetsRoot)) {
    if (!name.endsWith(".js")) continue;
    const target = path.join(assetsRoot, name);
    const source = await readFile(target, "utf8");
    if (source.includes(REGISTRY_BEFORE)) registryCandidates.push({ name, target, source });
    if (source.includes(COMPONENT_ANCHOR) && source.includes(GENERAL_BEFORE) && source.includes(USAGE_BEFORE)) panelCandidates.push({ name, target, source });
  }
  if (registryCandidates.length !== 1 || panelCandidates.length !== 1) {
    throw new Error(`Expected one original Settings registry and panel chunk, found ${registryCandidates.length}/${panelCandidates.length}.`);
  }
  const indexHtmlPath = path.join(stageRoot, "dist", "renderer", "index.html");
  await writeFile(indexHtmlPath, patchOriginalRendererHtml(await readFile(indexHtmlPath, "utf8")));
  const changes = [];
  for (const [role, candidate, transform] of [
    ["registry", registryCandidates[0], (source) => patchOriginalMainChrome(patchOriginalExpandedPlaceholder(patchOriginalSilentSend(patchOriginalComputerPlaceholder(patchOriginalMediaMeta(patchOriginalOverscan(patchOriginalScrollInput(patchOriginalClampRoot(patchOriginalClampObserver(patchOriginalAssistantClamp(patchOriginalImageTiles(patchOriginalVncQuality(patchOriginalViewFallback(patchOriginalComposerAttach(patchOriginalLoginWall(patchOriginalSettingsRegistry(source))))))))))))))))],
    ["panel", panelCandidates[0], patchOriginalSettingsPanel],
  ]) {
    const patched = transform(candidate.source);
    await writeFile(candidate.target, patched);
    changes.push({
      role,
      path: `dist/renderer/assets/${candidate.name}`,
      original: { bytes: Buffer.byteLength(candidate.source), sha256: sha256(candidate.source) },
      patched: { bytes: Buffer.byteLength(patched), sha256: sha256(patched) },
    });
  }
  const record = {
    schemaVersion: 1,
    mode: "original-renderer-settings-extension",
    chunks: changes,
    features: [
      "settings-router-provider",
      "settings-provider-computers",
      "settings-local-docker-vm",
      "usage-current-provider",
      "first-run-cursor-claude-codex",
      "first-run-login-skip",
      "computer-screen-switcher",
    ],
    transformations: ["settings-registry", "router-panel", "usage-panel", "first-run-logins", "first-run-login-skip", "computer-screen-switcher"],
  };
  const provenancePath = path.join(stageRoot, "dist", "renderer-router-extension.json");
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, provenancePath, provenanceBytes: (await stat(provenancePath)).size };
}
