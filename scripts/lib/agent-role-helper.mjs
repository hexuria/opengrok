// What a coworker is for, in its own settings pane.
//
// The pane already had a Description, and it went nowhere: the desktop sent it, the server filed
// it beside the avatar, and no model ever saw it. A person who wrote "reviews pull requests,
// terse, never guesses" there was writing to nobody.
//
// Role is that field made real. The server composes it with the title into the standing message
// every run carries — "You are New Bot, The Great." then the role, then the sentence saying it
// applies in every conversation — so it is the one field in this pane that changes how the
// coworker behaves rather than how it reads. It saves as you leave it, like everything else here,
// and it is capped at a thousand characters because the server caps it there.
//
// A server that does not serve the field yet says so plainly rather than pretending to save.

export const AGENT_ROLE_HELPER = String.raw`;(()=>{try{
var CSS=".sand-lp-role{margin:14px 0 0;padding:12px 14px;border:1px solid var(--sand-border-default,rgba(127,127,127,.28));border-radius:10px;display:flex;flex-direction:column;gap:8px}"
+".sand-lp-role h4{margin:0;font:600 13px system-ui,-apple-system,sans-serif}"
+".sand-lp-role textarea{width:100%;box-sizing:border-box;min-height:66px;resize:vertical;font:400 12.5px/1.5 system-ui,-apple-system,sans-serif;color:inherit;background:transparent;border:1px solid var(--sand-border-default,rgba(127,127,127,.4));border-radius:8px;padding:8px 10px}"
+".sand-lp-role textarea:focus{outline:none;border-color:var(--sand-fill-accent,#1084fe);box-shadow:0 0 0 3px color-mix(in srgb,var(--sand-fill-accent,#1084fe) 20%,transparent)}"
+".sand-lp-role textarea:disabled{opacity:.55}"
+".sand-lp-role .lp-role-foot{display:flex;align-items:baseline;gap:8px;font:400 11.5px system-ui,sans-serif;color:var(--sand-text-secondary,#5a5a5a)}"
+".sand-lp-role .lp-role-count{margin-left:auto;font-variant-numeric:tabular-nums}"
+".sand-lp-role .lp-role-count.over{color:#e5484d;font-weight:600}"
+".sand-lp-role .lp-role-err{margin:0;font:400 11.5px system-ui,sans-serif;color:#e5484d}";
var styled=false;var style=function(){if(styled)return;styled=true;var t=document.createElement("style");t.setAttribute("data-sand-role","1");t.textContent=CSS;(document.head||document.documentElement).appendChild(t)};
var el=function(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
var currentAgent=function(){var it=document.querySelector('.sand-agent-item[aria-current="page"]');return it?it.getAttribute("data-agent-id"):null};
var LIMIT=1000;
// A server without the field 404s the route; that is "not served yet", not a failure to save.
var notServed=function(e){return /404|not found|no such route|unknown route|failed \(404\)/i.test(String(e||""))};
var footFor=function(state){
  if(state==="unserved")return "This server does not carry a role yet. Saving is off until it does.";
  if(state==="saving")return "Saving…";
  if(state==="saved")return "Saved. Every run from now on carries it.";
  return "Sent to the model on every run, with the name and title above it."};
window.__sandRole={notServed:notServed,footFor:footFor,limit:LIMIT};

var mount=function(pane){
  var agentId=currentAgent();if(!agentId)return;
  var existing=pane.querySelector(".sand-lp-role");
  if(existing&&existing.getAttribute("data-lp-role")===agentId)return;
  if(existing)existing.remove();
  var a=window.desktop&&window.desktop.agent;if(!a||!a.setCoworkerRole||!a.getAgentModel)return;style();

  var box=el("div","sand-lp-role");box.setAttribute("data-lp-role",agentId);
  var h=el("h4",null,"Role");
  var area=el("textarea");area.setAttribute("aria-label","Role");area.placeholder="What this coworker is for. Reviews pull requests. Terse. Never guesses.";
  var foot=el("div","lp-role-foot");var note=el("span",null,footFor("idle"));var count=el("span","lp-role-count","");
  var err=el("p","lp-role-err","");
  foot.append(note,count);box.append(h,area,foot,err);
  // Under the page's own fields, above the Model block, because it reads as part of identity.
  var model=pane.querySelector(".sand-lp-model");
  if(model)model.parentNode.insertBefore(box,model);else pane.appendChild(box);
  box.parts={area:area,note:note,count:count,err:err};

  var saved="",served=true;
  var paintCount=function(){var n=area.value.length;count.textContent=n>LIMIT?n+" / "+LIMIT:(n>LIMIT-200?n+" / "+LIMIT:"");if(n>LIMIT)count.className="lp-role-count over";else count.className="lp-role-count"};
  var save=function(){
    if(!served)return;
    var next=area.value;
    if(next===saved)return;
    if(next.length>LIMIT){err.textContent="A role is at most "+LIMIT+" characters.";return}
    err.textContent="";note.textContent=footFor("saving");
    a.setCoworkerRole(agentId,next.length===0?null:next).then(function(r){
      if(r&&r.saved===false){
        if(notServed(r.error)){served=false;area.disabled=true;note.textContent=footFor("unserved")}
        else{err.textContent="Not saved: "+String(r.error||"the server refused");note.textContent=footFor("idle")}
        return}
      saved=next;note.textContent=footFor("saved")})
    .catch(function(e){err.textContent="Not saved: "+String(e&&e.message||e);note.textContent=footFor("idle")})};
  area.addEventListener("input",function(){err.textContent="";paintCount()});
  area.addEventListener("blur",save);

  var load=function(){if(!box.isConnected)return;
    var cat=window.__sandModels&&window.__sandModels.catalogue?window.__sandModels.catalogue(agentId):(a.getAgentModel?a.getAgentModel(agentId):Promise.resolve(null));
    Promise.resolve(cat).then(function(r){
      if(!r||r.available===false){box.style.display="none";return}
      box.style.display="";
      if(r.error)return;
      // The field is absent, not null, on a server that does not carry it yet.
      if(!("role" in r)){served=false;area.disabled=true;note.textContent=footFor("unserved");return}
      served=true;area.disabled=false;
      saved=typeof r.role==="string"?r.role:"";
      if(document.activeElement!==area)area.value=saved;
      paintCount()}).catch(function(){})};
  box.__sandRoleLoad=load;load()};

var scan=function(){var ps=document.querySelectorAll(".sand-agent-settings");for(var i=0;i<ps.length;i++)mount(ps[i])};
scan();new MutationObserver(scan).observe(document.documentElement,{childList:!0,subtree:!0});
}catch(_){}})();`;
