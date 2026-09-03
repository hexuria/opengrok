// Auto-review for one coworker: Manage on the settings pane, rules in a modal
// that matches Standing rules (tabs, add/delete) plus inherit / on / off.

export const AGENT_AUTOREVIEW_HELPER = String.raw`;(()=>{try{
var ROW=38,ROWS=10,LIST_H=(ROWS*ROW)+"px";
var CSS=".sand-lp-ar{margin:14px 0 0;padding:10px 14px;border:1px solid var(--sand-border-default,rgba(127,127,127,.28));border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:10px}"
+".sand-lp-ar h4{margin:0;font:600 13px system-ui,-apple-system,sans-serif}"
+".sand-lp-ar button{font:600 12px system-ui,sans-serif;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.4);border-radius:8px;padding:5px 11px;cursor:pointer}"
+".sand-ar-scrim{position:fixed;inset:0;z-index:2147483400;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--sand-bg-base,#000) 30%,rgba(0,0,0,.55));-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}"
+".sand-ar-sheet{width:min(520px,100%);box-sizing:border-box;border-radius:16px;padding:20px;border:1px solid var(--sand-border-default,rgba(128,128,128,.24));background:var(--sand-bg-elevated,Canvas);color:var(--sand-text-primary,CanvasText);box-shadow:0 24px 60px rgba(0,0,0,.35);font:13px/1.45 system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;gap:12px;outline:none}"
+".sand-ar-top{display:flex;align-items:center;justify-content:space-between;gap:8px}"
+".sand-ar-h{font-size:15px;font-weight:600;margin:0;flex:1}"
+".sand-ar-x{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer;font-size:18px;line-height:1;min-width:32px;min-height:32px;border-radius:6px}"
+".sand-ar-x:hover{background:var(--sand-fill-ghost-hover,rgba(128,128,128,.1))}"
+".sand-ar-sub{margin:0;font-size:12px;color:var(--sand-text-secondary,#5a5a5a);min-height:2.6em}"
+".sand-ar-seg,.sand-ar-tabs{display:flex;gap:8px;flex-wrap:wrap}"
+".sand-ar-seg button,.sand-ar-tabs button,.sand-ar-plus,.sand-ar-add button,.sand-ar-row button{font:inherit;font-size:12px;color:inherit;background:transparent;border:1px solid var(--sand-border-default,rgba(128,128,128,.3));border-radius:8px;padding:5px 10px;cursor:pointer}"
+".sand-ar-seg button[aria-pressed=true],.sand-ar-tabs button[aria-selected=true]{background:var(--sand-fill-neutral-subtle,rgba(128,128,128,.18));font-weight:600}"
+".sand-ar-tools{display:flex;align-items:center;justify-content:space-between;gap:8px}"
+".sand-ar-plus{min-width:32px}"
+".sand-ar-filter{font:inherit;font-size:13px;color:inherit;background:transparent;border:1px solid var(--sand-border-default,rgba(128,128,128,.3));border-radius:8px;padding:0 10px;height:34px;width:100%;box-sizing:border-box}"
+".sand-ar-stage{height:"+LIST_H+";min-height:"+LIST_H+";max-height:"+LIST_H+";overflow:auto;min-width:0;box-sizing:border-box}"
+".sand-ar-list{min-width:0}"
+".sand-ar-draft{display:none;width:100%;height:100%;box-sizing:border-box;resize:none;font:13px/1.45 system-ui,-apple-system,sans-serif;color:inherit;background:transparent;border:1px solid var(--sand-border-default,rgba(128,128,128,.3));border-radius:8px;padding:8px 10px}"
+".sand-ar-stage.compose .sand-ar-list,.sand-ar-stage.compose .sand-ar-filter{display:none}"
+".sand-ar-stage.compose .sand-ar-draft{display:block}"
+".sand-ar-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;min-width:0;height:"+ROW+"px;box-sizing:border-box}"
+".sand-ar-row .p{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sand-text-secondary,#5a5a5a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}"
+".sand-ar-add{display:flex;justify-content:flex-end;gap:8px;align-items:center}"
+".sand-ar-err{margin:0;font-size:12px;color:#e5484d;min-height:16px}";
var styled=false;var style=function(){if(styled)return;styled=true;var t=document.createElement("style");t.setAttribute("data-sand-ar","1");t.textContent=CSS;(document.head||document.documentElement).appendChild(t)};
var el=function(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
var currentAgent=function(){var it=document.querySelector('.sand-agent-item[aria-current="page"]');return it?it.getAttribute("data-agent-id"):null};
var rowsOf=function(v){if(v==null)return[];if(Array.isArray(v))return v.filter(function(x){return typeof x==="string"&&x.trim()}).map(function(x){return x.trim()});return String(v).split("\n").map(function(x){return x.trim()}).filter(Boolean)};
var modal=null;var onKey=null;
var close=function(){if(!modal)return;try{modal.el.remove()}catch(_){}if(onKey){document.removeEventListener("keydown",onKey);onKey=null}modal=null};

var open=function(agentId){agentId=agentId||currentAgent();var a=window.desktop&&window.desktop.agent;if(!a||!a.getAgentAutoReview||!agentId)return null;
  close();style();
  var m={agentId:agentId,mode:"inherit",tab:"allow",allow:[],block:[],filter:"",busy:false,compose:false};
  var scrim=el("div","sand-ar-scrim");scrim.setAttribute("role","dialog");scrim.setAttribute("aria-modal","true");scrim.setAttribute("aria-label","Auto-review");
  var sheet=el("div","sand-ar-sheet");sheet.tabIndex=-1;
  var top=el("div","sand-ar-top");var h=el("p","sand-ar-h","Auto-review");var x=el("button","sand-ar-x","×");x.type="button";x.setAttribute("aria-label","Close auto-review");x.addEventListener("click",close);top.append(h,x);
  var sub=el("p","sand-ar-sub","What this coworker may do. Inherit uses the global rules; On and Off set this coworker's own.");
  var seg=el("div","sand-ar-seg");seg.setAttribute("role","group");seg.setAttribute("aria-label","Reviewing");
  var modes=[["inherit","Inherit from global"],["on","On"],["off","Off"]];
  var modeBtns=modes.map(function(pair){var b=el("button",null,pair[1]);b.type="button";b.setAttribute("data-mode",pair[0]);b.addEventListener("click",function(){if(m.busy||m.mode===pair[0])return;m.mode=pair[0];paintMode();persist()});seg.appendChild(b);return b});
  var tools=el("div","sand-ar-tools");
  var tabs=el("div","sand-ar-tabs");tabs.setAttribute("role","tablist");tabs.setAttribute("aria-label","Rule kind");
  var tabAllow=el("button",null,"Allow");tabAllow.type="button";tabAllow.setAttribute("role","tab");tabAllow.setAttribute("data-tab","allow");
  var tabBlock=el("button",null,"Block");tabBlock.type="button";tabBlock.setAttribute("role","tab");tabBlock.setAttribute("data-tab","block");
  var plus=el("button","sand-ar-plus","+");plus.type="button";plus.setAttribute("aria-label","Add a rule");
  var setCompose=function(on){m.compose=!!on;stage.className=m.compose?"sand-ar-stage compose":"sand-ar-stage";filter.style.display=m.compose?"none":"";plus.setAttribute("aria-pressed",m.compose?"true":"false");if(m.compose){draft.value="";try{draft.focus()}catch(_){}}paintTabs()};
  var switchTab=function(id){m.tab=id;m.filter="";filter.value="";setCompose(false);paintTabs();paintList()};
  tabAllow.addEventListener("click",function(){switchTab("allow")});tabBlock.addEventListener("click",function(){switchTab("block")});
  plus.addEventListener("click",function(){setCompose(!m.compose)});
  tabs.append(tabAllow,tabBlock);tools.append(tabs,plus);
  var filter=el("input","sand-ar-filter");filter.type="text";filter.setAttribute("aria-label","Filter rules");filter.placeholder="Filter rules…";filter.addEventListener("input",function(){m.filter=filter.value;paintList()});
  var stage=el("div","sand-ar-stage");
  var list=el("div","sand-ar-list");list.setAttribute("role","tabpanel");list.tabIndex=0;
  var draft=el("textarea","sand-ar-draft");draft.setAttribute("aria-label","Rule to add");
  stage.append(list,draft);
  var add=el("div","sand-ar-add");var addBtn=el("button",null,"Allow");addBtn.type="button";
  var addRule=function(){var p=draft.value.trim();if(!p||m.busy)return;var bucket=m.tab==="allow"?m.allow:m.block;if(bucket.indexOf(p)<0)bucket.push(p);draft.value="";setCompose(false);paintTabs();paintList();persist()};
  draft.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();addRule()}});
  addBtn.addEventListener("click",addRule);add.appendChild(addBtn);
  var err=el("p","sand-ar-err","");
  var paintMode=function(){modeBtns.forEach(function(b){b.setAttribute("aria-pressed",b.getAttribute("data-mode")===m.mode?"true":"false")})};
  var paintTabs=function(){tabAllow.textContent="Allow ("+m.allow.length+")";tabBlock.textContent="Block ("+m.block.length+")";tabAllow.setAttribute("aria-selected",m.tab==="allow"?"true":"false");tabBlock.setAttribute("aria-selected",m.tab==="block"?"true":"false");draft.placeholder=m.tab==="allow"?"Always allow this…":"Always block this…";addBtn.textContent=m.tab==="allow"?"Allow":"Block"};
  var paintList=function(){list.textContent="";var rules=m.tab==="allow"?m.allow:m.block;var needle=m.filter.trim().toLowerCase();var shown=needle?rules.filter(function(p){return p.toLowerCase().indexOf(needle)>=0}):rules;
    if(shown.length===0){list.appendChild(el("p","sand-ar-sub",rules.length===0?(m.tab==="allow"?"No allow rules yet.":"No block rules yet."):"No rules match that filter."));return}
    var wrap=el("div");wrap.setAttribute("role","list");
    shown.forEach(function(p){var row=el("div","sand-ar-row");row.setAttribute("role","listitem");var span=el("span","p",p);var del=el("button",null,"Delete");del.type="button";del.setAttribute("aria-label","Delete the rule for "+p);del.addEventListener("click",function(){if(m.busy)return;var bucket=m.tab==="allow"?m.allow:m.block;var i=bucket.indexOf(p);if(i>=0)bucket.splice(i,1);paintTabs();paintList();persist()});row.append(span,del);wrap.appendChild(row)});
    list.appendChild(wrap)};
  var persist=function(){m.busy=true;err.textContent="";
    var inheritAll=m.mode==="inherit"&&m.allow.length===0&&m.block.length===0;
    var done=function(){m.busy=false;load()};var oops=function(e){m.busy=false;err.textContent=String(e&&e.message||e)};
    if(inheritAll){return a.deleteAgentAutoReview(agentId).then(done).catch(oops)}
    var enabled=m.mode==="on"?true:m.mode==="off"?false:null;
    var allowV=m.mode==="inherit"&&m.allow.length===0?null:m.allow.slice();
    var blockV=m.mode==="inherit"&&m.block.length===0?null:m.block.slice();
    return a.setAgentAutoReview(agentId,{enabled:enabled,allowInstructions:allowV,blockInstructions:blockV}).then(done).catch(oops)};
  var load=function(){return a.getAgentAutoReview(agentId).then(function(r){
    if(!r||r.available===false){close();return}
    if(r.error){err.textContent=String(r.error);return}
    var row=r.row||null;
    m.mode=row&&typeof row.enabled==="boolean"?(row.enabled?"on":"off"):"inherit";
    m.allow=rowsOf(row&&row.allowInstructions);
    m.block=rowsOf(row&&row.blockInstructions);
    paintMode();paintTabs();paintList()}).catch(function(e){err.textContent=String(e&&e.message||e)})};
  sheet.append(top,sub,seg,tools,filter,stage,add,err);scrim.appendChild(sheet);document.body.appendChild(scrim);
  onKey=function(e){if(e.key!=="Escape")return;e.preventDefault();if(m.compose){setCompose(false);return}close()};document.addEventListener("keydown",onKey);
  scrim.addEventListener("mousedown",function(e){if(e.target===scrim)close()});
  m.el=scrim;m.parts={sub:sub,seg:seg,tabs:tabs,plus:plus,list:list,draft:draft,addBtn:addBtn,err:err,filter:filter,stage:stage};modal=m;
  paintMode();paintTabs();paintList();load();
  return m};

var mount=function(pane){var agentId=currentAgent();if(!agentId)return;
  var existing=pane.querySelector(".sand-lp-ar");
  if(existing&&existing.getAttribute("data-lp-ar")===agentId)return;
  if(existing)existing.remove();
  var a=window.desktop&&window.desktop.agent;if(!a||!a.getAgentAutoReview)return;style();
  var box=el("div","sand-lp-ar");box.setAttribute("data-lp-ar",agentId);
  var h=el("h4",null,"Auto-review");
  var btn=el("button",null,"Manage…");btn.type="button";btn.setAttribute("aria-label","Manage auto-review");
  btn.addEventListener("click",function(){open(agentId)});
  box.append(h,btn);box.parts={open:btn};pane.appendChild(box);
  var load=function(){if(!box.isConnected)return;a.getAgentAutoReview(agentId).then(function(r){
    if(!r||r.available===false){box.style.display="none";return}box.style.display="";
  }).catch(function(){box.style.display=""})};
  box.__sandArLoad=load;load()};
var scan=function(){var ps=document.querySelectorAll(".sand-agent-settings");for(var i=0;i<ps.length;i++)mount(ps[i])};
window.__sandAutoReview={open:open,close:close,current:function(){return modal},rowsOf:rowsOf};
scan();new MutationObserver(scan).observe(document.documentElement,{childList:!0,subtree:!0});
}catch(_){}})();`;
