// Which model a coworker runs on, in its own settings pane.
//
// The pin lives on the server (PATCH /coworkers/{id}) and the catalogue on the gateway
// (GET /models); the desktop had no way to see either, so a coworker's model could only be
// changed from a console. This is the same shape as the auto-review block beside it: it mounts
// into `.sand-agent-settings`, keys itself on the coworker whose pane it is in, and re-reads
// after every change so what is shown is what the server holds.
//
// A deployment whose model door is a mock lists nothing and says so; the field is then a plain
// text box, because a pin still has to be typeable by hand.

export const AGENT_MODEL_HELPER = ';(()=>{try{'
  + 'var css=document.createElement("style");css.textContent='
  + '".sand-lp-model{margin:14px 0 0;padding:12px 14px;border:1px solid rgba(127,127,127,.28);border-radius:10px;display:flex;flex-direction:column;gap:8px}"'
  + '+".sand-lp-model h4{margin:0;font:600 13px system-ui,-apple-system,sans-serif}"'
  + '+".sand-lp-model .lp-model-sub{margin:0;font:400 11.5px system-ui,sans-serif;opacity:.65}"'
  + '+".sand-lp-model .lp-model-row{display:flex;gap:8px;align-items:center}"'
  + '+".sand-lp-model select,.sand-lp-model input{flex:1;min-width:0;font:400 12.5px system-ui,sans-serif;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.4);border-radius:8px;padding:5px 8px}"'
  + '+".sand-lp-model button{font:600 12px system-ui,sans-serif;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.4);border-radius:8px;padding:5px 11px;cursor:pointer}"'
  + '+".sand-lp-model button:disabled{opacity:.4;cursor:default}"'
  + '+".sand-lp-model .lp-model-err{margin:0;font:400 11.5px system-ui,sans-serif;color:#e5484d}";'
  + '(document.head||document.documentElement).appendChild(css);'
  + 'var currentAgent=function(){var it=document.querySelector(\'.sand-agent-item[aria-current="page"]\');return it?it.getAttribute("data-agent-id"):null};'
  // One catalogue read shared with anything else that lists models (the Usage modal's filter):
  // memoised per coworker for half a minute, dropped after a save so the pin is re-read.
  + 'var memo={};var catalogue=function(agentId,fresh){var a=window.desktop&&window.desktop.agent;if(!a||!a.getAgentModel)return Promise.resolve(null);var now=Date.now();var m=memo[agentId];if(!fresh&&m&&now-m.at<30000)return m.p;var p=a.getAgentModel(agentId).then(function(r){return r});memo[agentId]={at:now,p:p};p.catch(function(){delete memo[agentId]});return p};'
  + 'var shown=function(r,id){var p=r&&r.points&&r.points[id];return p&&p.shownX?" \\u00d7"+String(p.shownX):""};'
  + 'var hover=function(r,id){var p=r&&r.points&&r.points[id];if(!p)return "";var f=function(k,l){return p[k]?l+" \\u00d7"+String(p[k]):""};return [f("inputX","input"),f("outputX","output"),f("cacheReadX","cache read"),f("cacheWriteX","cache write")].filter(Boolean).join(" \\u00b7 ")};'
  + 'window.__sandModels={catalogue:catalogue,shown:shown,hover:hover,invalidate:function(id){delete memo[id]}};'
  + 'var mount=function(pane){'
  + '  var agentId=currentAgent();if(!agentId)return;'
  + '  var existing=pane.querySelector(".sand-lp-model");'
  + '  if(existing&&existing.getAttribute("data-lp-model")===agentId)return;'
  + '  if(existing)existing.remove();'
  + '  var a=window.desktop&&window.desktop.agent;if(!a||!a.getAgentModel)return;'
  + '  var box=document.createElement("div");box.className="sand-lp-model";box.setAttribute("data-lp-model",agentId);'
  + '  box.innerHTML=\'<h4>Model</h4>\''
  + '    +\'<p class="lp-model-sub" data-model-note>Reading the catalogue\\u2026</p>\''
  + '    +\'<div class="lp-model-row"><select data-model-pick></select><input data-model-typed type="text" placeholder="e.g. openai/gpt-5.6-luna" hidden><button data-model-save disabled>Save</button></div>\''
  + '    +\'<p class="lp-model-err" data-model-err></p>\';'
  + '  pane.appendChild(box);'
  + '  var q=function(k){return box.querySelector("[data-model-"+k+"]")};'
  + '  var note=q("note"),pick=q("pick"),typed=q("typed"),save=q("save"),err=q("err");'
  + '  var current=null;'
  + '  var chosen=function(){return typed.hidden?(pick.value||""):(typed.value||"").trim()};'
  + '  var refreshSave=function(){var v=chosen();save.disabled=v.length===0||v===current};'
  + '  pick.addEventListener("change",refreshSave);'
  + '  typed.addEventListener("input",refreshSave);'
  + '  var load=function(){catalogue(agentId,true).then(function(r){'
  + '    if(!r||r.available===false){box.style.display="none";return}'
  + '    if(r.error){err.textContent=String(r.error);note.textContent="The server could not be asked.";return}'
  + '    err.textContent="";'
  + '    current=typeof r.model==="string"&&r.model.length>0?r.model:"oag/auto";'
  + '    var models=Array.isArray(r.models)?r.models.slice():[];'
  // Only what the gateway advertises, plus whatever this coworker is on. There is no "no pin"
  // to offer: a coworker always has a model, and `oag/auto` is an ordinary route id that is
  // refused wherever no credential matches it — offering it as "automatic" would pin coworkers
  // to a route that refuses every turn.
  + '    if(models.indexOf(current)===-1)models.unshift(current);'
  + '    if(models.length<=1&&r.note){'
  + '      typed.hidden=!1;pick.hidden=!0;typed.value=current;'
  + '      note.textContent=String(r.note);'
  + '    }else{'
  + '      typed.hidden=!0;pick.hidden=!1;pick.textContent="";'
  + '      models.forEach(function(id){var o=document.createElement("option");o.value=id;o.textContent=id+shown(r,id);var hv=hover(r,id);if(hv)o.title=hv;if(id===current)o.selected=!0;pick.appendChild(o)});'
  + '      note.textContent="Running on "+current+". "+(models.length-1)+" other"+(models.length===2?"":"s")+" the gateway advertises.";'
  + '    }'
  + '    refreshSave();'
  + '  }).catch(function(e){err.textContent=String(e&&e.message||e)})};'
  + '  save.addEventListener("click",function(){'
  + '    var next=chosen();if(next.length===0||next===current)return;'
  + '    err.textContent="";save.disabled=!0;note.textContent="Checking that the gateway serves it\\u2026";'
  // The server proves the pin with a real completion before saving it, so a refusal arrives
  // here in the gateway's own words instead of as a coworker that answers nothing.
  + '    a.setAgentModel(agentId,next).then(function(r){if(r&&r.pinned===!1){err.textContent="Not pinned: "+(r.detail||"the gateway would not serve it")}load()}).catch(function(e){err.textContent=String(e&&e.message||e);load()});'
  + '  });'
  + '  load();'
  + '};'
  + 'var scan=function(){var ps=document.querySelectorAll(".sand-agent-settings");for(var i=0;i<ps.length;i++)mount(ps[i])};'
  + 'scan();new MutationObserver(scan).observe(document.documentElement,{childList:!0,subtree:!0});'
  + '}catch(_){}})();';
