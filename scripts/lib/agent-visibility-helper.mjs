// Who may talk to a coworker, in its own settings pane.
//
// A coworker used to belong to whoever hired it and to nobody else: no second person could see it,
// let alone use it. Visibility is the switch that changes that — private keeps it yours, org lets
// every member of the organisation talk to it, each in their own conversation, on their own
// budget.
//
// The server decides who may flip it and says so on the roster row (`canManage`); this block
// renders that verdict and never works it out for itself. It also shows whose coworker it is when
// it is not yours, because "shared with me" and "mine" are different things to a person.
//
// A server that does not carry visibility yet says so rather than offering a switch that lies.

export const AGENT_VISIBILITY_HELPER = String.raw`;(()=>{try{
var CSS=".sand-lp-vis{margin:14px 0 0;padding:12px 14px;border:1px solid var(--sand-border-default,rgba(127,127,127,.28));border-radius:10px;display:flex;flex-direction:column;gap:8px}"
+".sand-lp-vis h4{margin:0;font:600 13px system-ui,-apple-system,sans-serif}"
+".sand-lp-vis .lp-vis-row{display:flex;align-items:center;gap:8px}"
+".sand-lp-vis select{flex:1;min-width:0;font:400 12.5px system-ui,sans-serif;color:inherit;background-color:transparent;border:1px solid var(--sand-border-default,rgba(127,127,127,.4));border-radius:8px;padding:6px 30px 6px 10px;-webkit-appearance:none;appearance:none;background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%23888' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>\");background-repeat:no-repeat;background-position:right 10px center;background-size:12px 12px}"
+".sand-lp-vis select:disabled{opacity:.55}"
+".sand-lp-vis .lp-vis-sub{margin:0;font:400 11.5px system-ui,sans-serif;color:var(--sand-text-secondary,#5a5a5a)}"
+".sand-lp-vis .lp-vis-err{margin:0;font:400 11.5px system-ui,sans-serif;color:#e5484d}";
var styled=false;var style=function(){if(styled)return;styled=true;var t=document.createElement("style");t.setAttribute("data-sand-vis","1");t.textContent=CSS;(document.head||document.documentElement).appendChild(t)};
var el=function(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
var currentAgent=function(){var it=document.querySelector('.sand-agent-item[aria-current="page"]');return it?it.getAttribute("data-agent-id"):null};
var notServed=function(e){return /404|not found|no such route|unknown route|failed \(404\)/i.test(String(e||""))};
var ownerName=function(o){return o&&typeof o==="object"&&typeof o.name==="string"&&o.name.length>0?o.name:""};
// What the line under the switch says, given the row the server sent.
var subFor=function(r){
  if(!r||!("visibility" in r))return "This server does not carry visibility yet.";
  var who=ownerName(r.owner);
  if(r.canManage===false)return (who?who+"'s coworker":"Somebody else's coworker")+", shared with your organisation. Only its owner or an admin can change that.";
  if(r.visibility==="org")return "Everyone in your organisation can talk to this coworker, each in their own conversation and on their own budget.";
  return "Only you can talk to this coworker."};
window.__sandVisibility={subFor:subFor,notServed:notServed,ownerName:ownerName};

var mount=function(pane){
  var agentId=currentAgent();if(!agentId)return;
  var existing=pane.querySelector(".sand-lp-vis");
  if(existing&&existing.getAttribute("data-lp-vis")===agentId)return;
  if(existing)existing.remove();
  var a=window.desktop&&window.desktop.agent;if(!a||!a.setCoworkerVisibility||!a.getAgentModel)return;style();

  var box=el("div","sand-lp-vis");box.setAttribute("data-lp-vis",agentId);
  var h=el("h4",null,"Who can talk to it");
  var row=el("div","lp-vis-row");var sel=el("select");sel.setAttribute("aria-label","Who can talk to it");
  [["private","Only me"],["org","Everyone in my organisation"]].forEach(function(o){var op=el("option",null,o[1]);op.value=o[0];sel.appendChild(op)});
  row.appendChild(sel);
  var sub=el("p","lp-vis-sub","");var err=el("p","lp-vis-err","");
  box.append(h,row,sub,err);
  // Under Role, above Model: name, then what it is for, then who it is for, then how it runs.
  var model=pane.querySelector(".sand-lp-model");
  if(model)model.parentNode.insertBefore(box,model);else pane.appendChild(box);
  box.parts={select:sel,sub:sub,err:err};

  var current=null,served=true;
  sel.addEventListener("change",function(){
    var next=sel.value;if(!served||sel.disabled||next===current)return;
    err.textContent="";sub.textContent="Saving…";
    a.setCoworkerVisibility(agentId,next).then(function(r){
      if(r&&r.saved===false){
        sel.value=current||"private";
        if(notServed(r.error)){served=false;sel.disabled=true;sub.textContent=subFor(null)}
        else{err.textContent="Not saved: "+String(r.error||"the server refused");sub.textContent=subFor({visibility:current,canManage:true})}
        return}
      current=next;load()})
    .catch(function(e){sel.value=current||"private";err.textContent="Not saved: "+String(e&&e.message||e)})});

  var load=function(){if(!box.isConnected)return;
    var cat=window.__sandModels&&window.__sandModels.catalogue?window.__sandModels.catalogue(agentId):a.getAgentModel(agentId);
    Promise.resolve(cat).then(function(r){
      if(!r||r.available===false){box.style.display="none";return}
      box.style.display="";if(r.error)return;
      if(!("visibility" in r)){served=false;sel.disabled=true;sub.textContent=subFor(null);return}
      served=true;current=r.visibility;sel.value=r.visibility;
      // The server's verdict, rendered: absent means nobody said no.
      sel.disabled=r.canManage===false;
      sub.textContent=subFor(r)}).catch(function(){})};
  box.__sandVisLoad=load;load()};

var scan=function(){var ps=document.querySelectorAll(".sand-agent-settings");for(var i=0;i<ps.length;i++)mount(ps[i])};
scan();new MutationObserver(scan).observe(document.documentElement,{childList:!0,subtree:!0});
}catch(_){}})();`;
