// What a coworker has spent: one line in its settings pane, and a modal with the detail.
//
// Usage is a report. The server reads its gateway ledger per coworker and per model
// (GET /coworkers/{id}/usage?window=): requests, tokens, what the turns actually cost, what they
// would have cost at list price, and points (list cost over the admin's reference price). The
// pane, which is crowded, keeps one line under the Model block with an Open button; the modal
// holds the table, a period switch (5 h, 24 h, 7 d, month), and the same model list the picker
// uses as a filter, each model suffixed with its ×N.
//
// Limits are a separate thing and sit in their own section of the modal: the coworker's monthly
// cap and daily brake (the owner writes them, GET/PUT /coworkers/{id}/limit) and the owner's
// pool (the admin's, read-only here). Every point figure carries its dollar equivalent.
//
// A server older than the points work has neither route. The line then falls back to the meter
// (GET /coworkers/{id}/spend), and the modal says plainly what is not served yet, so the package
// installs at every step of the rollout.

export const AGENT_USAGE_HELPER = String.raw`;(()=>{try{
var CSS=".sand-lp-usage{margin:14px 0 0;padding:10px 14px;border:1px solid rgba(127,127,127,.28);border-radius:10px;display:flex;align-items:center;gap:10px}"
+".sand-lp-usage h4{margin:0;font:600 13px system-ui,-apple-system,sans-serif}"
+".sand-lp-usage .lp-usage-sum{flex:1;min-width:0;margin:0;font:400 12px system-ui,sans-serif;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
+".sand-lp-usage button{font:600 12px system-ui,sans-serif;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.4);border-radius:8px;padding:5px 11px;cursor:pointer}"
+".sand-us-scrim{position:fixed;inset:0;z-index:2147483400;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--sand-bg-base,#000) 30%,rgba(0,0,0,.55));-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);animation:sand-us-fade .12s ease-out}"
+"@keyframes sand-us-fade{from{opacity:0}to{opacity:1}}"
+".sand-us-sheet{width:min(760px,100%);max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;border-radius:16px;padding:20px 22px;border:1px solid var(--sand-border-default,rgba(128,128,128,.24));background:var(--sand-bg-elevated,Canvas);color:var(--sand-text-primary,CanvasText);box-shadow:0 24px 60px rgba(0,0,0,.35);font:13px/1.45 system-ui,-apple-system,sans-serif;outline:none}"
+".sand-us-top{display:flex;align-items:center;gap:12px;margin:0 0 4px}"
+".sand-us-h{font-size:15px;font-weight:600;margin:0;flex:1}"
+".sand-us-x{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:6px}"
+".sand-us-x:hover{background:var(--sand-fill-ghost-hover,rgba(128,128,128,.1))}"
+".sand-us-sub{margin:0 0 12px;font-size:12px;color:var(--sand-text-secondary,#5a5a5a)}"
+".sand-us-row{display:flex;align-items:center;gap:10px;margin:0 0 12px;flex-wrap:wrap}"
+".sand-us-seg{display:inline-flex;border:1px solid var(--sand-border-default,rgba(128,128,128,.3));border-radius:8px;overflow:hidden}"
+".sand-us-seg button{font:inherit;font-size:12px;color:inherit;background:transparent;border:0;padding:5px 10px;cursor:pointer}"
+".sand-us-seg button[aria-pressed=true]{background:var(--sand-fill-neutral-subtle,rgba(128,128,128,.18));font-weight:600}"
+".sand-us-row label{font-size:12px;color:var(--sand-text-secondary,#5a5a5a);margin-left:auto}"
+".sand-us-row select{font:inherit;font-size:12.5px;color:inherit;background:transparent;border:1px solid var(--sand-border-default,rgba(128,128,128,.3));border-radius:8px;padding:5px 8px;min-width:220px}"
+".sand-us-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:12.5px}"
+".sand-us-table th{text-align:left;font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--sand-text-secondary,#5a5a5a);padding:6px 8px;border-bottom:1px solid var(--sand-border-default,rgba(128,128,128,.24))}"
+".sand-us-table td{padding:6px 8px;border-bottom:1px solid var(--sand-border-default,rgba(128,128,128,.14))}"
+".sand-us-table td.n,.sand-us-table th.n{text-align:right;white-space:nowrap}"
+".sand-us-table tr.t td{font-weight:600;border-bottom:0}"
+".sand-us-note{margin:8px 0 0;font-size:12px;color:var(--sand-text-secondary,#5a5a5a)}"
+".sand-us-err{margin:8px 0 0;font-size:12px;color:#e5484d}"
+".sand-us-lim{margin:18px 0 0;padding-top:12px;border-top:1px solid var(--sand-border-default,rgba(128,128,128,.24))}"
+".sand-us-lim h5{margin:0 0 8px;font-size:13px;font-weight:600}"
+".sand-us-lim .f{display:flex;align-items:center;gap:8px;margin:0 0 8px;flex-wrap:wrap}"
+".sand-us-lim .f label{width:96px;font-size:12px;color:var(--sand-text-secondary,#5a5a5a)}"
+".sand-us-lim input{width:120px;font:inherit;font-size:12.5px;color:inherit;background:transparent;border:1px solid var(--sand-border-default,rgba(128,128,128,.3));border-radius:8px;padding:5px 8px;text-align:right}"
+".sand-us-lim .eq{font-size:12px;color:var(--sand-text-secondary,#5a5a5a);min-width:110px}"
+".sand-us-lim button{font:inherit;font-size:12px;font-weight:600;color:inherit;background:transparent;border:1px solid var(--sand-border-default,rgba(128,128,128,.3));border-radius:8px;padding:5px 11px;cursor:pointer}"
+".sand-us-lim button:disabled{opacity:.4;cursor:default}";
var styled=false;var style=function(){if(styled)return;styled=true;var t=document.createElement("style");t.setAttribute("data-sand-usage","1");t.textContent=CSS;(document.head||document.documentElement).appendChild(t)};
var el=function(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
var currentItem=function(){return document.querySelector('.sand-agent-item[aria-current="page"]')};
var currentAgent=function(){var it=currentItem();return it?it.getAttribute("data-agent-id"):null};
var currentName=function(){var it=currentItem();var t=it?(it.getAttribute("aria-label")||it.textContent||""):"";return String(t).replace(/\s+/g," ").trim().slice(0,60)};
var num=function(s){if(s==null||s==="")return null;var n=Number(s);return isNaN(n)?null:n};
var usd=function(n){return "$"+(n>0&&n<0.01?n.toFixed(4):n.toFixed(2))};
var money=function(s){var n=num(s);return n===null?"—":usd(n)};
var int=function(n){n=Math.round(Number(n)||0);return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,",")};
var pts=function(n){return n==null?"—":int(n)};
var plural=function(n,w){return int(n)+" "+w+(n===1?"":"s")};
var usdOfPoints=function(p,R){var r=num(R);if(p==null||r===null||r<=0)return "";return "≈ "+usd(p*r/1e6)};
var spanOf=function(ms){var m=Math.round(ms/60000);if(m<1)return "under a minute";var h=Math.floor(m/60),d=Math.floor(h/24);if(d>=1)return d+"d "+(h%24)+"h";if(h>=1)return h+"h "+(m%60)+"m";return m+"m"};
var resetDay=function(iso){var t=Date.parse(iso);return isNaN(t)?"":new Date(t).toLocaleDateString(undefined,{day:"numeric",month:"short"})};
var when=function(w,now){if(!w||!w.freesAt)return "";var t=Date.parse(w.freesAt);if(isNaN(t))return "";if(w.window==="month")return "resets "+resetDay(w.freesAt);return "frees in "+spanOf(t-now)};
var LABEL={"5h":"Last 5 hours","24h":"Last 24 hours","7d":"Last 7 days","month":"This month"};
// One meter window as words, for the pane line when the server serves only the meter.
var figure=function(w,seat,spent){var used=num(w.usedUsd),limit=num(w.limitUsd),cf=num(w.counterfactualUsd);var reqs=typeof w.requests==="number"?w.requests:null;
  var sub=seat==="subscription"||(seat!=="api"&&(used===null||used===0)&&cf!==null&&cf>0);
  var empty=(w.freesAt&&w.window!=="month"||spent)&&reqs===null?"$0.00 spent":"nothing yet";
  if(sub){if(reqs===0||(reqs===null&&!(cf>0)))return empty;var s=reqs===null?"":plural(reqs,"request");if(cf!==null&&cf>0)s+=(s?" · ":"")+usd(cf)+" on API";return s||empty}
  if((used===null||used===0)&&(reqs===null||reqs===0))return limit!==null?empty+" · limit "+usd(limit):empty;
  var t=usd(used||0)+(limit!==null?" of "+usd(limit):" · no limit");if(reqs!==null)t+=" · "+plural(reqs,"request");return t};
var rowOf=function(m){return {model:String(m.modelId||m.model||""),requests:Number(m.requests)||0,tokIn:m.inputTokens==null?null:Number(m.inputTokens)||0,tokOut:m.outputTokens==null?null:Number(m.outputTokens)||0,list:num(m.listUsd),actual:num(m.costUsd),points:m.points==null?null:Number(m.points)}};
// The table for one window, narrowed to one model when a filter is set; totals are summed here so
// they follow the filter.
var table=function(u,filter){var rows=(u&&Array.isArray(u.models)?u.models:[]).map(rowOf);if(filter&&filter!=="all")rows=rows.filter(function(r){return r.model===filter});
  var t={requests:0,tokIn:0,tokOut:0,tokensKnown:true,list:0,actual:0,points:0,pointsKnown:true};rows.forEach(function(r){t.requests+=r.requests;if(r.tokIn==null&&r.tokOut==null)t.tokensKnown=false;else{t.tokIn+=r.tokIn||0;t.tokOut+=r.tokOut||0}t.list+=r.list||0;t.actual+=r.actual||0;if(r.points==null)t.pointsKnown=false;else t.points+=r.points});return {rows:rows,totals:t}};
// The pane line: the month in one sentence, from per-model usage when served, else from the meter.
var summary=function(r,spend){if(r&&r.usage){var t=table(r.usage,"all").totals;if(t.requests===0)return "nothing this month";var s=plural(t.requests,"request")+" this month";if(t.pointsKnown)s+=" · "+pts(t.points)+" points";else s+=" · "+usd(t.list)+" on API";return s}
  var sp=spend&&spend.spend;if(!sp)return "";var ws=Array.isArray(sp.windows)?sp.windows:[];var m=null,spent=false;for(var i=0;i<ws.length;i++){var w=ws[i]||{};if(w.window==="month")m=w;else if(w.freesAt)spent=true}
  if(sp.metered===false)return "not metered"+(sp.note?": "+String(sp.note):"");if(!m)return "";var seat=sp.seat==="subscription"||sp.seat==="api"?sp.seat:null;var f=figure(m,seat,spent);return f==="nothing yet"?"nothing this month":f+" this month"};
var seatLine=function(s){if(!s)return "";if(s.metered===false)return "Not metered"+(s.note?": "+String(s.note):".");var seat=s.seat==="subscription"?"Subscription seat":s.seat==="api"?"API key":"Metered";return seat+(s.keyPrefix?" · key "+String(s.keyPrefix)+"…":"")};
// The pool sentence and the "nothing is set" line for the limits section.
var limitsText=function(l,R){var out={pool:"",none:""};if(!l)return out;var pool=l.pool||{};
  if(pool.max!=null){var eq=usdOfPoints(pool.max,R);var used=pool.used==null?"usage unknown until your admin sets a reference price":int(pool.used)+" of "+int(pool.max)+" used";out.pool="Your pool: "+(pool.used==null?int(pool.max)+" points, ":"")+used+(eq?" ("+eq+")":"")+(pool.setBy?", set by your "+String(pool.setBy):"")+(pool.resetsAt?", resets "+resetDay(pool.resetsAt):"")+"."}
  else out.pool="No pool. Your admin has not set one.";
  if(l.cap==null&&l.dayCap==null&&pool.max==null)out.none="No limits. This coworker draws on nothing but the gateway's own budgets.";
  else if(l.cap==null&&l.dayCap==null)out.none="No cap on this coworker; it draws on your pool.";
  return out};
var notServed=function(e){return /404|not found|no such route|unknown route|failed \(404\)/i.test(String(e||""))};
var modal=null;var onKey=null;
var close=function(){if(!modal)return;try{modal.el.remove()}catch(_){}if(onKey){document.removeEventListener("keydown",onKey);onKey=null}modal=null};
var open=function(agentId){agentId=agentId||currentAgent();var a=window.desktop&&window.desktop.agent;if(!agentId||!a||!a.getCoworkerUsage)return null;close();style();
  var m={agentId:agentId,window:"month",filter:"all",usage:null,limit:null,parts:{}};var P=m.parts;
  var scrim=el("div","sand-us-scrim");scrim.setAttribute("role","dialog");scrim.setAttribute("aria-modal","true");scrim.setAttribute("aria-label","Usage");
  var sheet=el("div","sand-us-sheet");sheet.tabIndex=-1;
  var top=el("div","sand-us-top");var h=el("p","sand-us-h",(currentName()||"Coworker")+" · Usage");var x=el("button","sand-us-x","×");x.type="button";x.setAttribute("aria-label","Close");x.addEventListener("click",close);top.append(h,x);
  var sub=el("p","sand-us-sub","Reading the ledger…");P.sub=sub;
  var row=el("div","sand-us-row");var seg=el("div","sand-us-seg");seg.setAttribute("role","group");seg.setAttribute("aria-label","Period");P.periods=[];
  ["5h","24h","7d","month"].forEach(function(w){var b=el("button",null,w==="month"?"Month":w);b.type="button";b.setAttribute("data-window",w);b.setAttribute("aria-pressed",w===m.window?"true":"false");b.addEventListener("click",function(){m.window=w;P.periods.forEach(function(o){o.setAttribute("aria-pressed",o.getAttribute("data-window")===w?"true":"false")});loadUsage()});P.periods.push(b);seg.appendChild(b)});
  var lab=el("label",null,"Model");var sel=el("select");sel.setAttribute("aria-label","Model");sel.addEventListener("change",function(){m.filter=sel.value||"all";paint()});P.filter=sel;lab.appendChild(sel);row.append(seg,lab);
  var tbl=el("table","sand-us-table");var thead=el("thead");var hr=el("tr");[["Model",""],["Requests","n"],["Tokens in / out","n"],["List","n"],["Actual","n"],["Points","n"]].forEach(function(c){var th=el("th",c[1]||null,c[0]);hr.appendChild(th)});thead.appendChild(hr);var tbody=el("tbody");tbl.append(thead,tbody);P.table=tbl;P.tbody=tbody;
  var note=el("p","sand-us-note","");P.note=note;var err=el("p","sand-us-err","");P.err=err;
  var lim=el("div","sand-us-lim");lim.appendChild(el("h5",null,"Limits"));
  var mk=function(label,key){var f=el("div","f");var l=el("label",null,label);var i=el("input");i.type="text";i.inputMode="numeric";i.setAttribute("aria-label",label+" in points");i.placeholder="none";var eq=el("span","eq","");i.addEventListener("input",function(){var v=parse(i.value);eq.textContent=v===0?"0 = nothing may run":usdOfPoints(v,m.R)||(i.value.trim()?"":key==="cap"?"none = your pool":"none = off");refreshSave()});f.append(l,i,eq);lim.appendChild(f);P[key]=i;P[key+"Eq"]=eq};
  mk("Monthly cap","cap");mk("Daily brake","dayCap");
  var foot=el("div","f");var save=el("button",null,"Save");save.type="button";save.disabled=true;var st=el("span","eq","");foot.append(save,st);lim.appendChild(foot);P.save=save;P.saveNote=st;
  var pool=el("p","sand-us-note","");P.pool=pool;lim.appendChild(pool);var limNote=el("p","sand-us-note","");P.limNote=limNote;lim.appendChild(limNote);P.lim=lim;
  var parse=function(v){v=String(v||"").replace(/[,\s]/g,"");if(v==="")return null;var n=Number(v);return Number.isInteger(n)&&n>=0?n:NaN};
  var refreshSave=function(){var c=parse(P.cap.value),d=parse(P.dayCap.value);var bad=(c!==c)||(d!==d);var same=m.limit&&(c===(m.limit.cap==null?null:Number(m.limit.cap)))&&(d===(m.limit.dayCap==null?null:Number(m.limit.dayCap)));save.disabled=bad||!!same||!m.limit;if(bad)st.textContent="whole points only";else if(st.textContent==="whole points only")st.textContent=""};
  save.addEventListener("click",function(){var c=parse(P.cap.value),d=parse(P.dayCap.value);if(c!==c||d!==d)return;save.disabled=true;st.textContent="Saving…";a.setCoworkerLimit(agentId,c,d).then(function(r){if(r&&r.saved===false){st.textContent="Not saved: "+String(r.error||"the server refused")}else{st.textContent="Saved"}loadLimit()}).catch(function(e){st.textContent="Not saved: "+String(e&&e.message||e)})});
  var paint=function(){tbody.textContent="";var u=m.usage;if(!u)return;var tt=table(u,m.filter);
    tt.rows.forEach(function(r){var tr=el("tr");var sh=window.__sandModels&&m.cat?window.__sandModels.shown(m.cat,r.model):"";tr.append(el("td",null,r.model+sh),el("td","n",int(r.requests)),el("td","n",r.tokIn==null&&r.tokOut==null?"—":int(r.tokIn||0)+" / "+int(r.tokOut||0)),el("td","n",r.list==null?"—":usd(r.list)),el("td","n",r.actual==null?"—":usd(r.actual)),el("td","n",pts(r.points)));tbody.appendChild(tr)});
    var t=tt.totals;var tr=el("tr","t");tr.append(el("td",null,(m.filter==="all"?LABEL[m.window]:LABEL[m.window]+" · "+m.filter)),el("td","n",int(t.requests)),el("td","n",t.tokensKnown?int(t.tokIn)+" / "+int(t.tokOut):"—"),el("td","n",usd(t.list)),el("td","n",usd(t.actual)),el("td","n",t.pointsKnown?pts(t.points):"—"));tbody.appendChild(tr);
    if(tt.rows.length===0)note.textContent="Nothing in this window.";};
  var fillFilter=function(ids){var keep=m.filter;sel.textContent="";var all=el("option",null,"All models");all.value="all";sel.appendChild(all);ids.forEach(function(id){var o=el("option",null,id+(window.__sandModels&&m.cat?window.__sandModels.shown(m.cat,id):""));o.value=id;if(window.__sandModels&&m.cat){var hv=window.__sandModels.hover(m.cat,id);if(hv)o.title=hv}sel.appendChild(o)});sel.value=ids.indexOf(keep)>=0?keep:"all";m.filter=sel.value};
  var models=function(){var ids=[];var add=function(id){if(id&&ids.indexOf(id)<0)ids.push(id)};if(m.cat&&Array.isArray(m.cat.models))m.cat.models.forEach(add);if(m.usage&&Array.isArray(m.usage.models))m.usage.models.forEach(function(r){add(String(r.modelId||r.model||""))});return ids};
  var loadUsage=function(){if(!scrim.isConnected)return;err.textContent="";note.textContent="";a.getCoworkerUsage(agentId,m.window).then(function(r){
      if(!r||r.available===false){sub.textContent="This route has no OpenGrok server.";return}
      if(r.error){m.usage=null;var served=!notServed(r.error);if(served)err.textContent="The server could not be asked. "+String(r.error);
        // Older server: the meter still answers, so the window is shown as one row.
        return (a.getCoworkerSpend?a.getCoworkerSpend(agentId):Promise.resolve(null)).then(function(s){var sp=s&&s.spend;sub.textContent=seatLine(sp)||sub.textContent;var ws=sp&&Array.isArray(sp.windows)?sp.windows:[];var w=null;for(var i=0;i<ws.length;i++)if(ws[i]&&ws[i].window===m.window)w=ws[i];
          m.usage={models:w?[{modelId:"All models",requests:typeof w.requests==="number"?w.requests:0,costUsd:w.usedUsd,listUsd:w.counterfactualUsd,points:null}]:[]};fillFilter(models().filter(function(id){return id!=="All models"}));paint();
          if(!served)note.textContent="Per-model usage is not served by this server yet; this is the meter's total for the window."+(w&&when(w,Date.now())?" It "+when(w,Date.now())+".":"")}).catch(function(){})}
      m.usage=r.usage;sub.textContent=seatLine(r.usage)||"";fillFilter(models());paint()}).catch(function(e){err.textContent="The server could not be asked. "+String(e&&e.message||e)})};
  var loadLimit=function(){if(!scrim.isConnected||!a.getCoworkerLimit){lim.hidden=true;return}a.getCoworkerLimit(agentId).then(function(r){
      if(!r||r.available===false){lim.hidden=true;return}
      if(r.error){m.limit=null;P.cap.disabled=true;P.dayCap.disabled=true;save.disabled=true;limNote.textContent=notServed(r.error)?"Limits are not served by this server yet.":"The server could not be asked. "+String(r.error);return}
      var l=r.limit||{};m.limit=l;m.R=l.reference&&l.reference.usdPerMtok;P.cap.disabled=false;P.dayCap.disabled=false;
      P.cap.value=l.cap==null?"":int(l.cap);P.capEq.textContent=l.cap==null?"none = your pool":Number(l.cap)===0?"0 = nothing may run":usdOfPoints(Number(l.cap),m.R)+(l.effectiveCap!=null&&Number(l.effectiveCap)!==Number(l.cap)?" · effective "+int(l.effectiveCap):"");
      P.dayCap.value=l.dayCap==null?"":int(l.dayCap);P.dayCapEq.textContent=l.dayCap==null?"none = off":usdOfPoints(Number(l.dayCap),m.R)+(l.usedToday!=null?" · "+int(l.usedToday)+" used today":"");
      var lt=limitsText(l,m.R);pool.textContent=lt.pool;limNote.textContent=l.metered===false&&l.note?"Not metered: "+String(l.note)+(lt.none?" "+lt.none:""):lt.none;refreshSave()}).catch(function(e){limNote.textContent="The server could not be asked. "+String(e&&e.message||e)})};
  sheet.append(top,sub,row,tbl,note,err,lim);scrim.appendChild(sheet);document.body.appendChild(scrim);
  onKey=function(e){if(e.key==="Escape"){e.preventDefault();close()}};document.addEventListener("keydown",onKey);
  scrim.addEventListener("mousedown",function(e){if(e.target===scrim)close()});
  m.el=scrim;m.refresh=function(){loadUsage();loadLimit()};modal=m;
  var cat=window.__sandModels?window.__sandModels.catalogue(agentId):Promise.resolve(null);
  Promise.resolve(cat).then(function(c){m.cat=c&&c.available!==false&&!c.error?c:null}).catch(function(){m.cat=null}).then(function(){loadUsage();loadLimit()});
  var tick=setInterval(function(){if(!scrim.isConnected){clearInterval(tick);return}loadUsage()},20000);
  setTimeout(function(){try{sheet.focus()}catch(_){}},30);
  return m};
// The pane line under the Model block.
var mount=function(pane){var agentId=currentAgent();if(!agentId)return;var model=pane.querySelector(".sand-lp-model");var existing=pane.querySelector(".sand-lp-usage");
  if(existing&&existing.getAttribute("data-lp-usage")===agentId){if(model&&existing.previousElementSibling!==model)model.insertAdjacentElement("afterend",existing);return}
  if(existing)existing.remove();var a=window.desktop&&window.desktop.agent;if(!a||!a.getCoworkerUsage)return;style();
  var box=el("div","sand-lp-usage");box.setAttribute("data-lp-usage",agentId);var h=el("h4",null,"Usage");var sum=el("p","lp-usage-sum","Reading…");var btn=el("button",null,"Open");btn.type="button";btn.setAttribute("aria-label","Open usage");btn.addEventListener("click",function(){open(agentId)});box.append(h,sum,btn);box.parts={sum:sum,open:btn};
  if(model)model.insertAdjacentElement("afterend",box);else pane.appendChild(box);
  var load=function(){if(!box.isConnected)return;a.getCoworkerUsage(agentId,"month").then(function(r){if(!r||r.available===false){box.style.display="none";return}box.style.display="";
      if(r.usage){sum.textContent=summary(r,null);return}
      return (a.getCoworkerSpend?a.getCoworkerSpend(agentId):Promise.resolve(null)).then(function(s){var t=summary(null,s);sum.textContent=t||(notServed(r.error)?"not served by this server yet":"the server could not be asked")})}).catch(function(e){sum.textContent="the server could not be asked"})};
  var tick=setInterval(function(){if(!box.isConnected){clearInterval(tick);return}load()},30000);box.__sandUsageLoad=load;load()};
var scan=function(){var ps=document.querySelectorAll(".sand-agent-settings");for(var i=0;i<ps.length;i++)mount(ps[i])};
window.__sandUsage={open:open,close:close,current:function(){return modal},table:table,summary:summary,figure:figure,limitsText:limitsText,money:money,pts:pts,usdOfPoints:usdOfPoints,refresh:function(){var b=document.querySelector(".sand-lp-usage");if(b&&b.__sandUsageLoad)b.__sandUsageLoad();if(modal)modal.refresh()}};
scan();new MutationObserver(scan).observe(document.documentElement,{childList:!0,subtree:!0});
}catch(_){}})();`;
