// What a coworker has spent, in its own settings pane, under the Model block.
//
// The server meters each coworker on a gateway key of its own (GET /coworkers/{id}/spend) and
// answers three rolling windows: five hours, seven days, the month. On a subscription seat every
// turn is priced at zero, so "$0.00" three times would say nothing; the server then also carries
// the request count and what the same turns would have cost on an API key, and the block words
// itself around those. On an API key the figures are money against a limit.
//
// Same shape as the Model block beside it: mounts into `.sand-agent-settings`, keys itself on
// the coworker whose pane it is in, sits directly under the Model block, and re-reads while the
// pane is open so a turn that just finished shows up without reopening it.

export const AGENT_USAGE_HELPER = ';(()=>{try{'
  + 'var css=document.createElement("style");css.textContent='
  + '".sand-lp-usage{margin:14px 0 0;padding:12px 14px;border:1px solid rgba(127,127,127,.28);border-radius:10px;display:flex;flex-direction:column;gap:8px}"'
  + '+".sand-lp-usage h4{margin:0;font:600 13px system-ui,-apple-system,sans-serif}"'
  + '+".sand-lp-usage .lp-usage-sub{margin:0;font:400 11.5px system-ui,sans-serif;opacity:.65}"'
  + '+".sand-lp-usage table{border-collapse:collapse;width:100%;font:400 12.5px system-ui,sans-serif}"'
  + '+".sand-lp-usage td{padding:3px 0;vertical-align:baseline}"'
  + '+".sand-lp-usage td:first-child{opacity:.65;white-space:nowrap;padding-right:14px;width:1%}"'
  + '+".sand-lp-usage td:last-child{font-variant-numeric:tabular-nums}"'
  + '+".sand-lp-usage .lp-usage-when{opacity:.55;font-size:11.5px;margin-left:8px}"'
  + '+".sand-lp-usage .lp-usage-err{margin:0;font:400 11.5px system-ui,sans-serif;color:#e5484d}";'
  + '(document.head||document.documentElement).appendChild(css);'
  + 'var currentAgent=function(){var it=document.querySelector(\'.sand-agent-item[aria-current="page"]\');return it?it.getAttribute("data-agent-id"):null};'
  // Money arrives as a string and leaves as one: two decimals, or four when the sum is real but
  // would round to nothing, so "$0.0012 on API" stays a number rather than a lie of "$0.00".
  + 'var num=function(s){if(s==null||s==="")return null;var n=Number(s);return isNaN(n)?null:n};'
  + 'var usd=function(n){return "$"+(n>0&&n<0.01?n.toFixed(4):n.toFixed(2))};'
  + 'var plural=function(n,w){return n+" "+w+(n===1?"":"s")};'
  + 'var spanOf=function(ms){var m=Math.round(ms/60000);if(m<1)return "under a minute";var h=Math.floor(m/60),d=Math.floor(h/24);if(d>=1)return d+"d "+(h%24)+"h";if(h>=1)return h+"h "+(m%60)+"m";return m+"m"};'
  + 'var when=function(w,now){if(!w.freesAt)return "";var t=Date.parse(w.freesAt);if(isNaN(t))return "";'
  + '  if(w.window==="month")return "resets "+new Date(t).toLocaleDateString(undefined,{day:"numeric",month:"short"});'
  + '  return "frees in "+spanOf(t-now)};'
  + 'var labelOf={"5h":"Last 5 hours","7d":"Last 7 days","month":"This month"};'
  // One window as words. Subscription: requests and the counterfactual; API: money against the
  // limit; either way an empty window says so instead of showing zeros.
  + 'var figure=function(w,seat,spent){var used=num(w.usedUsd),limit=num(w.limitUsd),cf=num(w.counterfactualUsd);var reqs=typeof w.requests==="number"?w.requests:null;'
  + '  var sub=seat==="subscription"||(seat!=="api"&&(used===null||used===0)&&cf!==null&&cf>0);'
  // A window that will "free" something has spend in it, whatever the figures say: an older
  // server sends neither count nor counterfactual, and then the honest line is the zero itself.
  + '  var empty=(w.freesAt&&w.window!=="month"||spent)&&reqs===null?"$0.00 spent":"nothing yet";'
  + '  if(sub){if(reqs===0||(reqs===null&&!(cf>0)))return empty;var s=reqs===null?"":plural(reqs,"request");if(cf!==null&&cf>0)s+=(s?" \\u00b7 ":"")+usd(cf)+" on API";return s||empty}'
  + '  if((used===null||used===0)&&(reqs===null||reqs===0))return limit!==null?empty+" \\u00b7 limit "+usd(limit):empty;'
  + '  var t=usd(used||0)+(limit!==null?" of "+usd(limit):" \\u00b7 no limit");if(reqs!==null)t+=" \\u00b7 "+plural(reqs,"request");return t};'
  + 'var describe=function(r,now){now=now||Date.now();var out={rows:[],note:"",hidden:false};if(!r||r.available===false){out.hidden=true;return out}'
  + '  if(r.error){out.error="The server could not be asked. "+String(r.error);return out}'
  + '  var s=r.spend||{};var seat=s.seat==="subscription"||s.seat==="api"?s.seat:null;'
  + '  if(s.metered===false){out.note="Not metered"+(s.note?": "+String(s.note):".")}'
  + '  else{out.note=(seat==="subscription"?"Subscription seat":seat==="api"?"API key":"Metered")+(s.keyPrefix?" \\u00b7 key "+String(s.keyPrefix)+"\\u2026":"")}'
  // The month always has a reset date, so it cannot tell on its own; spend in a shorter window
  // is spend in the month.
  + '  var ws=Array.isArray(s.windows)?s.windows:[];var spent=false;for(var i=0;i<ws.length;i++){var v=ws[i]||{};if(v.window!=="month"&&v.freesAt)spent=true}'
  + '  for(var i=0;i<ws.length;i++){var w=ws[i]||{};out.rows.push({label:labelOf[w.window]||String(w.window||""),figure:figure(w,seat,w.window==="month"&&spent),when:when(w,now)})}'
  + '  return out};'
  + 'var mount=function(pane){'
  + '  var agentId=currentAgent();if(!agentId)return;'
  + '  var model=pane.querySelector(".sand-lp-model");'
  + '  var existing=pane.querySelector(".sand-lp-usage");'
  + '  if(existing&&existing.getAttribute("data-lp-usage")===agentId){'
  // The Model block re-mounts itself on an agent switch; stay directly under it.
  + '    if(model&&existing.previousElementSibling!==model)model.insertAdjacentElement("afterend",existing);return}'
  + '  if(existing)existing.remove();'
  + '  var a=window.desktop&&window.desktop.agent;if(!a||!a.getCoworkerSpend)return;'
  + '  var box=document.createElement("div");box.className="sand-lp-usage";box.setAttribute("data-lp-usage",agentId);'
  + '  box.innerHTML=\'<h4>Usage</h4><p class="lp-usage-sub" data-usage-note>Reading the meter\\u2026</p><table data-usage-rows></table><p class="lp-usage-err" data-usage-err></p>\';'
  + '  if(model)model.insertAdjacentElement("afterend",box);else pane.appendChild(box);'
  + '  var q=function(k){return box.querySelector("[data-usage-"+k+"]")};var note=q("note"),rows=q("rows"),err=q("err");'
  + '  var paint=function(d){if(d.hidden){box.style.display="none";return}box.style.display="";err.textContent=d.error||"";if(d.error)return;note.textContent=d.note;rows.textContent="";'
  + '    for(var i=0;i<d.rows.length;i++){var tr=document.createElement("tr"),a1=document.createElement("td"),b1=document.createElement("td");a1.textContent=d.rows[i].label;b1.textContent=d.rows[i].figure;'
  + '      if(d.rows[i].when){var sp=document.createElement("span");sp.className="lp-usage-when";sp.textContent=d.rows[i].when;b1.appendChild(sp)}tr.appendChild(a1);tr.appendChild(b1);rows.appendChild(tr)}};'
  + '  var load=function(){if(!box.isConnected)return;a.getCoworkerSpend(agentId).then(function(r){paint(describe(r))}).catch(function(e){paint({rows:[],error:"The server could not be asked. "+String(e&&e.message||e)})})};'
  // A turn that just finished should show without reopening the pane: re-read every half
  // minute while the block is on screen, and stop the moment it is gone.
  + '  var tick=setInterval(function(){if(!box.isConnected){clearInterval(tick);return}load()},30000);'
  + '  box.__sandUsageLoad=load;load();'
  + '};'
  + 'var scan=function(){var ps=document.querySelectorAll(".sand-agent-settings");for(var i=0;i<ps.length;i++)mount(ps[i])};'
  + 'window.__sandUsage={describe:describe,figure:figure,refresh:function(){var b=document.querySelector(".sand-lp-usage");if(b&&b.__sandUsageLoad)b.__sandUsageLoad()}};'
  + 'scan();new MutationObserver(scan).observe(document.documentElement,{childList:!0,subtree:!0});'
  + '}catch(_){}})();';
