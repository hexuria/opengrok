// Which model a coworker runs on, in its own settings pane.
//
// The pin lives on the server (PATCH /coworkers/{id}) and the catalogue on the gateway
// (GET /models); the desktop had no way to see either, so a coworker's model could only be
// changed from a console. This mounts into `.sand-agent-settings`, keys itself on the coworker
// whose pane it is in, and re-reads after every change so what is shown is what the server holds.
//
// The control is a combobox, not a dropdown: fifteen routes with names like
// `openai/gpt-5-codex@sub` are a list you search, not one you scroll. Typing filters over both
// the written label and the raw id, the options are grouped, and the keyboard drives it the way
// the ARIA pattern says — the cursor moves through the list while focus stays in the input.
//
// An id is written out for people: `xai/grok-4.6@sub` reads "xAI: grok-4.6 · subscription".
// Beside the field is the model's credit multiplier, which is the only cost signal shown; the
// gateway's tier names say nothing the multiplier does not.
//
// Choosing a model saves it. There is no probe and no Test button: a probe is a real completion
// the server rate-limits, and a model that will not answer is fixed by picking another.

export const AGENT_MODEL_HELPER = String.raw`;(()=>{try{
var CSS=".sand-lp-model{margin:14px 0 0;padding:12px 14px;border:1px solid var(--sand-border-default,rgba(127,127,127,.28));border-radius:10px;display:flex;flex-direction:column;gap:8px}"
+".sand-lp-model h4{margin:0;font:600 13px system-ui,-apple-system,sans-serif}"
+".sand-lp-model .lp-model-sub{margin:0;font:400 11.5px system-ui,sans-serif;color:var(--sand-text-secondary,#5a5a5a)}"
+".sand-lp-model .lp-model-err{margin:0;font:400 11.5px system-ui,sans-serif;color:#e5484d}"
+".sand-lp-model .lp-model-row{display:flex;gap:8px;align-items:center}"
+".sand-lp-cb{position:relative;flex:1;min-width:0}"
+".sand-lp-cb input{width:100%;box-sizing:border-box;font:400 12.5px system-ui,sans-serif;color:inherit;background:transparent;border:1px solid var(--sand-border-default,rgba(127,127,127,.4));border-radius:8px;padding:6px 28px 6px 10px}"
+".sand-lp-cb input:focus{outline:none;border-color:var(--sand-fill-accent,#1084fe);box-shadow:0 0 0 3px color-mix(in srgb,var(--sand-fill-accent,#1084fe) 20%,transparent)}"
+".sand-lp-cb .lp-chev{position:absolute;right:9px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:.5;font-size:11px}"
+".sand-lp-x{font:600 12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sand-text-secondary,#5a5a5a);white-space:nowrap;min-width:2.4em;text-align:right}"
+".sand-lp-list{position:absolute;z-index:2147483300;left:0;right:0;top:calc(100% + 4px);max-height:262px;overflow:auto;margin:0;padding:4px;list-style:none;box-sizing:border-box;border:1px solid var(--sand-border-default,rgba(127,127,127,.28));border-radius:10px;background:var(--sand-bg-elevated,Canvas);color:var(--sand-text-primary,CanvasText);box-shadow:0 14px 34px rgba(0,0,0,.28)}"
+".sand-lp-list.up{top:auto;bottom:calc(100% + 4px)}"
+".sand-lp-list .lp-grp{font:600 10px system-ui,sans-serif;letter-spacing:.07em;text-transform:uppercase;color:var(--sand-text-secondary,#5a5a5a);padding:7px 8px 3px}"
+".sand-lp-list .lp-opt{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;font:400 12.5px system-ui,sans-serif}"
+".sand-lp-list .lp-opt[aria-selected=true]{font-weight:600}"
+".sand-lp-list .lp-opt.on{background:var(--sand-fill-neutral-subtle,rgba(127,127,127,.16))}"
+".sand-lp-list .lp-opt .lp-m{margin-left:auto;font:600 11.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sand-text-secondary,#5a5a5a)}"
+".sand-lp-list .lp-none{padding:8px;font:400 12px system-ui,sans-serif;color:var(--sand-text-secondary,#5a5a5a)}";
var styled=false;var style=function(){if(styled)return;styled=true;var t=document.createElement("style");t.setAttribute("data-sand-model","1");t.textContent=CSS;(document.head||document.documentElement).appendChild(t)};
var el=function(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
var currentAgent=function(){var it=document.querySelector('.sand-agent-item[aria-current="page"]');return it?it.getAttribute("data-agent-id"):null};

// A route id written for a person. The vendor is a known name where we know it, capitalised
// where we do not; the @suffix is spelled out, because "@sub" means a subscription seat.
var VENDORS={xai:"xAI",openai:"OpenAI",anthropic:"Anthropic",oag:"OAG",google:"Google",meta:"Meta",mistral:"Mistral",deepseek:"DeepSeek",moonshot:"Moonshot",qwen:"Qwen",cohere:"Cohere",perplexity:"Perplexity"};
var SUFFIXES={sub:"subscription",api:"API"};
var labelOf=function(id){id=String(id==null?"":id);if(!id)return "";
  var at=id.indexOf("@");var base=at<0?id:id.slice(0,at);var suf=at<0?"":id.slice(at+1);
  var slash=base.indexOf("/");var vendor=slash<0?"":base.slice(0,slash);var model=slash<0?base:base.slice(slash+1);
  var v=vendor?(VENDORS[vendor.toLowerCase()]||vendor.charAt(0).toUpperCase()+vendor.slice(1)):"";
  var s=suf?" · "+(SUFFIXES[suf.toLowerCase()]||suf):"";
  return (v?v+": ":"")+model+s};
// Two groups, and two more that appear only when they have something in them.
var LADDER="Let the gateway choose",PIN="Pin a model",GONE="Not in the catalogue",TYPED="Use exactly what you typed";
var groupOf=function(id){return String(id||"").indexOf("oag/")===0?LADDER:PIN};
var matches=function(id,q){if(!q)return true;q=q.toLowerCase();return labelOf(id).toLowerCase().indexOf(q)>=0||String(id).toLowerCase().indexOf(q)>=0};
// The option list for a query: the catalogue filtered, the current pin kept even when the
// gateway has stopped advertising it, and last of all the literal text, so typing a few letters
// still highlights a real model rather than the string itself.
var optionsFor=function(ids,current,query){
  var q=String(query||"").trim();var out=[];var seen={};
  var push=function(id,group){if(!id||seen[id])return;seen[id]=1;out.push({id:id,label:labelOf(id),group:group})};
  var listed={};(ids||[]).forEach(function(id){listed[id]=1});
  (ids||[]).forEach(function(id){if(matches(id,q)&&groupOf(id)===LADDER)push(id,LADDER)});
  (ids||[]).forEach(function(id){if(matches(id,q)&&groupOf(id)===PIN)push(id,PIN)});
  if(current&&!listed[current]&&matches(current,q))push(current,GONE);
  if(q&&!seen[q]&&!listed[q])out.push({id:q,label:q,group:TYPED});
  return out};

var memo={};
var catalogue=function(agentId,fresh){var a=window.desktop&&window.desktop.agent;if(!a||!a.getAgentModel)return Promise.resolve(null);
  var now=Date.now();var m=memo[agentId];if(!fresh&&m&&now-m.at<30000)return m.p;
  var p=a.getAgentModel(agentId).then(function(r){return r});memo[agentId]={at:now,p:p};p.catch(function(){delete memo[agentId]});return p};
var shown=function(r,id){var p=r&&r.points&&r.points[id];return p&&p.shownX?" ×"+String(p.shownX):""};
var multOf=function(r,id){var p=r&&r.points&&r.points[id];return p&&p.shownX?"×"+String(p.shownX):""};
var hover=function(r,id){var p=r&&r.points&&r.points[id];if(!p)return "";var f=function(k,l){return p[k]?l+" ×"+String(p[k]):""};return [f("inputX","input"),f("outputX","output"),f("cacheReadX","cache read"),f("cacheWriteX","cache write")].filter(Boolean).join(" · ")};
window.__sandModels={catalogue:catalogue,shown:shown,hover:hover,label:labelOf,options:optionsFor,multiplier:multOf,invalidate:function(id){delete memo[id]}};

var mount=function(pane){
  var agentId=currentAgent();if(!agentId)return;
  var existing=pane.querySelector(".sand-lp-model");
  if(existing&&existing.getAttribute("data-lp-model")===agentId)return;
  if(existing)existing.remove();
  var a=window.desktop&&window.desktop.agent;if(!a||!a.getAgentModel)return;style();

  var box=el("div","sand-lp-model");box.setAttribute("data-lp-model",agentId);
  var h=el("h4",null,"Model");
  var row=el("div","lp-model-row");
  var cb=el("div","sand-lp-cb");
  var input=el("input");input.type="text";input.autocomplete="off";input.spellcheck=false;
  input.setAttribute("role","combobox");input.setAttribute("aria-expanded","false");input.setAttribute("aria-autocomplete","list");
  input.setAttribute("aria-label","Model");input.id="sand-lp-model-input-"+agentId;
  var list=el("ul","sand-lp-list");list.id="sand-lp-model-list-"+agentId;list.setAttribute("role","listbox");list.hidden=true;
  input.setAttribute("aria-controls",list.id);
  var chev=el("span","lp-chev","⌄");
  var mult=el("span","sand-lp-x","");
  cb.append(input,chev,list);row.append(cb,mult);
  var note=el("p","lp-model-sub","Reading the catalogue…");
  var err=el("p","lp-model-err","");
  box.append(h,row,note,err);pane.appendChild(box);
  box.parts={input:input,list:list,mult:mult,note:note,err:err};

  var cat=null,ids=[],current=null,opts=[],active=-1,open=false;

  var labelNow=function(){return current?labelOf(current):""};
  var close=function(restore){open=false;list.hidden=true;list.textContent="";input.setAttribute("aria-expanded","false");input.removeAttribute("aria-activedescendant");active=-1;if(restore)input.value=labelNow()};
  var paint=function(){
    list.textContent="";var group=null;
    if(opts.length===0){list.appendChild(el("li","lp-none","No model by that name."));return}
    opts.forEach(function(o,i){
      if(o.group!==group){group=o.group;var g=el("li","lp-grp",group);g.setAttribute("role","presentation");list.appendChild(g)}
      var li=el("li","lp-opt"+(i===active?" on":""));li.setAttribute("role","option");li.id=list.id+"-"+i;
      li.setAttribute("aria-selected",o.id===current?"true":"false");
      li.appendChild(el("span",null,o.label));
      var m=multOf(cat,o.id);if(m)li.appendChild(el("span","lp-m",m));
      var hv=hover(cat,o.id);if(hv)li.title=hv;
      // mousedown, not click: the input must not blur and restore before the choice lands.
      li.addEventListener("mousedown",function(e){e.preventDefault();choose(o.id)});
      list.appendChild(li)});
    if(active>=0)input.setAttribute("aria-activedescendant",list.id+"-"+active);else input.removeAttribute("aria-activedescendant")};
  var refresh=function(query){opts=optionsFor(ids,current,query);active=opts.length?0:-1;paint()};
  var show=function(query){
    open=true;list.hidden=false;input.setAttribute("aria-expanded","true");refresh(query);
    // Below by default, above when there is no room for it there.
    try{var r=input.getBoundingClientRect();var room=(window.innerHeight||0)-r.bottom;if(room<180&&r.top>room)list.className="sand-lp-list up";else list.className="sand-lp-list"}catch(_){}};
  var move=function(step){if(!open){show("");return}if(!opts.length)return;active=(active+step+opts.length)%opts.length;paint();
    var rows=list.children;for(var i=0;i<rows.length;i++){if(rows[i].id===list.id+"-"+active&&rows[i].scrollIntoView)rows[i].scrollIntoView({block:"nearest"})}};
  var choose=function(id){
    if(!id||id===current){close(true);return}
    close(false);input.value=labelOf(id);err.textContent="";note.textContent="Saving…";
    var after=function(msg){delete memo[agentId];return Promise.resolve(load()).then(function(){if(msg)err.textContent=msg})};
    a.setAgentModel(agentId,id).then(function(r){return after(r&&r.saved===false?"Not saved: "+String(r.error||"the server refused"):"")})
    .catch(function(e){return after("Not saved: "+String(e&&e.message||e))})};

  input.addEventListener("focus",function(){try{input.select()}catch(_){}show("")});
  input.addEventListener("input",function(){if(!open)show(input.value);else refresh(input.value)});
  input.addEventListener("blur",function(){setTimeout(function(){if(open)close(true)},0)});
  input.addEventListener("keydown",function(e){
    if(e.key==="ArrowDown"){e.preventDefault();move(1)}
    else if(e.key==="ArrowUp"){e.preventDefault();move(-1)}
    else if(e.key==="Enter"){if(!open)return;e.preventDefault();if(active>=0&&opts[active])choose(opts[active].id)}
    else if(e.key==="Escape"){if(!open)return;e.preventDefault();e.stopPropagation();close(true)}
    else if(e.key==="Tab"){if(open)close(true)}});
  chev.addEventListener("mousedown",function(e){e.preventDefault();if(open)close(true);else{input.focus()}});

  var load=function(){if(!box.isConnected)return Promise.resolve();return catalogue(agentId,true).then(function(r){
    if(!r||r.available===false){box.style.display="none";return}
    box.style.display="";
    if(r.error){err.textContent=String(r.error);note.textContent="The server could not be asked.";return}
    err.textContent="";cat=r;
    current=typeof r.model==="string"&&r.model.length>0?r.model:null;
    ids=Array.isArray(r.models)?r.models.slice():[];
    input.value=labelNow();mult.textContent=current?multOf(r,current):"";
    input.title=current?String(current):"";
    if(ids.length===0){note.textContent=r.note?String(r.note):"The gateway advertises nothing right now; whatever you type is the pin."}
    else{var others=ids.filter(function(id){return id!==current}).length;
      note.textContent=(current?"Running on "+labelNow()+". ":"")+others+" other"+(others===1?"":"s")+" the gateway advertises."}
    if(open)refresh(input.value)}).catch(function(e){err.textContent=String(e&&e.message||e)})};
  box.__sandModelLoad=load;load()};

var scan=function(){var ps=document.querySelectorAll(".sand-agent-settings");for(var i=0;i<ps.length;i++)mount(ps[i])};
scan();new MutationObserver(scan).observe(document.documentElement,{childList:!0,subtree:!0});
}catch(_){}})();`;
