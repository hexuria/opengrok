// Selection mode for the transcript: entered from a message's "Select messages" item or
// Cmd/Ctrl+Shift+A. A toolbar takes the chat header's place while selecting: an "Add N loaded"
// button, the count, and icon buttons (share to a collection, bookmark, delete, close); every
// message row gets a checkbox on its left; click toggles, shift-click ranges.
//
// There is no "select all". The feed is virtualized, so the app only knows the messages it has
// loaded; a select-all could only ever mean "select what happens to be loaded", which read as a
// promise it could not keep and, once pressed, left nothing to add. "Add N loaded" says exactly
// what it does: it adds, it never takes away, and pressing it again after scrolling adds the
// newly loaded ones. Clear takes the selection back to nothing.
//
// Rows are React's, so nothing is written into them: the checkboxes and tints are painted on a
// fixed overlay from the rows' boxes, repainted on scroll, mutation and a slow tick. A short
// row's checkbox sits at its middle; a tall one's near its top, where the eye starts, and never
// above the toolbar when the row is half behind it.
//
// Message ids come from the row's `aria-labelledby` (`sand-conversation-entry-<id>-author …`),
// which every entry row carries on every route; `data-row-key` is the client nonce on the
// person's own messages and a local-route id (`t12u`) on the local router (accepted only on a
// `.sand-transcript-row`: a date separator borrows the next entry's key), and the old helper
// accepted only the latter, so on the OpenGrok route nothing could be selected at all
// ("0 selected", "Select at least one message").
//
// `window.__sandTombstones` (device-local hiding for Cursor's remote box, which nothing here can
// delete from) is kept here because the row builder filters through it.

const TOMBSTONES =
  'var TK="sandTombstones.v1";var tcache=null;var tload=function(){if(tcache)return tcache;try{tcache=JSON.parse(localStorage.getItem(TK)||"{}")}catch(_){tcache={}}return tcache};'
  + 'var tsave=function(){try{localStorage.setItem(TK,JSON.stringify(tcache||{}))}catch(_){}};'
  + 'var tsets={};var tset=function(ag){if(!ag)return null;if(!tsets[ag]){var o=tload();tsets[ag]=new Set(o[ag]||[])}return tsets[ag]};'
  + 'window.__sandTombstones={'
  + 'add:function(ag,ids){if(!ag||!ids||!ids.length)return;var o=tload();var s=tset(ag);ids.forEach(function(i){s.add(i)});o[ag]=Array.from(s);tsave()},'
  + 'clearAgent:function(ag){var o=tload();delete o[ag];delete tsets[ag];tsave()},'
  + 'size:function(){var o=tload();var n=0;for(var k in o)n+=o[k].length;return n},'
  + 'filter:function(list){try{var ag=self.__sandCurrentAgent&&self.__sandCurrentAgent();var s=tset(ag);if(!s||!s.size)return list;return list.filter(function(en){return!(en&&s.has(en.id))})}catch(_){return list}}};';

const CSS =
  '".sand-sel-layer{position:fixed;inset:0;pointer-events:none;z-index:9998}"'
  // The app's own greys: an outlined box, filled with the text colour when checked, the mark in
  // the background colour. No accent, no tint on the row.
  + '+".sand-sel-box{position:absolute;width:18px;height:18px;border-radius:4px;border:1.5px solid rgba(127,127,127,.75);background:transparent;box-sizing:border-box}"'
  + '+".sand-sel-box.on{background:#e8e8ec;border-color:#e8e8ec}"'
  + '+".sand-sel-box.on::after{content:\\"\\";position:absolute;left:5px;top:2px;width:4px;height:8px;border:solid #1b1b1f;border-width:0 2px 2px 0;transform:rotate(45deg)}"'
  + '+"html[data-theme*=light] .sand-sel-box.on{background:#1b1b1f;border-color:#1b1b1f}html[data-theme*=light] .sand-sel-box.on::after{border-color:#fff}"'
  + '+".sand-sel-bar{position:fixed;z-index:10001;display:flex;align-items:center;gap:6px;padding:6px 12px;box-sizing:border-box;font:500 13px system-ui;background:#f4f4f5;color:#222;border-bottom:1px solid rgba(0,0,0,.12)}"'
  + '+"html[data-theme*=dark] .sand-sel-bar{background:#1b1b1f;color:#eee;border-color:rgba(255,255,255,.12)}"'
  + '+"@media (prefers-color-scheme:dark){html:not([data-theme*=light]) .sand-sel-bar{background:#1b1b1f;color:#eee;border-color:rgba(255,255,255,.12)}}"'
  + '+".sand-sel-bar[hidden]{display:none}"'
  + '+".sand-sel-bar .sand-sel-count{font-weight:600;margin-left:6px}"'
  + '+".sand-sel-bar .sand-sel-note{opacity:.7;margin-left:4px}"'
  + '+".sand-sel-bar .sand-sel-spacer{flex:1}"'
  + '+".sand-sel-bar button{display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:32px;padding:0 8px;border-radius:8px;border:0;background:transparent;color:inherit;font:600 12px system-ui;cursor:pointer}"'
  + '+".sand-sel-bar button:hover:not(:disabled){background:rgba(127,127,127,.18)}"'
  + '+".sand-sel-bar button:disabled{opacity:.35;cursor:default}"'
  + '+".sand-sel-bar button.sand-sel-danger{color:#e5484d}"'
  + '+".sand-sel-bar button svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}"'
  + '+".sand-sel-bar button.sand-sel-text{border:1px solid rgba(127,127,127,.4)}"'
  + '+".sand-sel-bar button.sand-sel-add{gap:7px;padding:0 12px;border:1px solid rgba(127,127,127,.4)}"'
  + '+".sand-sel-plus{position:relative;width:14px;height:14px;flex:0 0 auto;opacity:.9}"'
  + '+".sand-sel-plus::before,.sand-sel-plus::after{content:\\"\\";position:absolute;background:currentColor;border-radius:1px}"'
  + '+".sand-sel-plus::before{left:0;top:6px;width:14px;height:2px}"'
  + '+".sand-sel-plus::after{left:6px;top:0;width:2px;height:14px}"'
  + '+".sand-sel-bar button.sand-sel-clear{margin-left:2px;opacity:.85}"'
  + '+".sand-sel-bar input{font:500 13px system-ui;border:1px solid rgba(127,127,127,.4);border-radius:8px;padding:5px 9px;background:transparent;color:inherit;min-width:180px}"';

// Static inline SVG (Lucide-style strokes); nothing from the page goes into innerHTML.
const ICONS =
  'var ICON={'
  + 'share:\'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>\','
  + 'star:\'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>\','
  + 'trash:\'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>\','
  + 'x:\'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>\'};';

export const SELECT_MODE_HELPER =
  ';(()=>{try{'
  + TOMBSTONES
  + 'var ADDR=/^t(?:\\d+u(?:a\\d+)?|(?:\\d+|b)[as]\\d+)$/;'
  + 'var st={on:false,ids:new Set(),anchor:null,agent:null};'
  + 'var css=document.createElement("style");css.textContent=' + CSS + ';document.head.appendChild(css);'
  + ICONS
  + 'var layer=document.createElement("div");layer.className="sand-sel-layer";layer.hidden=true;document.body.appendChild(layer);'
  + 'var bar=document.createElement("div");bar.className="sand-sel-bar";bar.setAttribute("role","toolbar");bar.setAttribute("aria-label","Selected messages");bar.hidden=true;document.body.appendChild(bar);'
  // Only a message bubble is selectable: a row whose label names a conversation entry (the
  // person's, another member's, or the bot's), or an attachment group. Date separators and
  // cards carry a borrowed entry id and no such label; they get nothing.
  + 'var entryIdOf=function(row){if(!row||!row.getAttribute)return null;var lab=row.getAttribute("aria-labelledby")||"";var m=/sand-conversation-entry-(.+?)-(?:author|timestamp|body)(?:\\s|$)/.exec(lab);return m?m[1]:null};'
  + 'var idsOf=function(row){if(!row)return[];var multi=row.getAttribute("data-entry-ids");if(multi)return multi.split(" ").filter(Boolean);var id=entryIdOf(row);return id?[id]:[]};'
  + 'var scroller=function(){return document.querySelector(".sand-virtual-transcript")};'
  + 'var rows=function(){var sc=scroller();return sc?Array.prototype.slice.call(sc.querySelectorAll("[data-row-key]")).filter(function(r){return idsOf(r).length>0}):[]};'
  + 'var loadedIds=function(){var out=[];rows().forEach(function(r){idsOf(r).forEach(function(i){out.indexOf(i)===-1&&out.push(i)})});return out};'
  + 'var agentIdNow=function(){try{var a=self.__sandCurrentAgent&&self.__sandCurrentAgent();if(a)return a}catch(_){}var el=document.querySelector(".sand-agent-item[aria-current=page]")||document.querySelector(".sand-agent-item[aria-pressed=true]");return el?el.getAttribute("data-agent-id")||"":""};'
  // The bar takes the chat header's place while selecting (as an edit mode does), so no
  // transcript row is ever hidden behind it.
  + 'var column=function(){var sc=scroller();return document.querySelector("main.sand-chat")||(sc&&sc.closest&&sc.closest(".ui-scroll-area"))||sc};'
  + 'var colLeft=function(){var col=column();return col?col.getBoundingClientRect().left:0};'
  // While selecting, the transcript gets a gutter as wide as the checkbox plus the bubbles'
  // usual edge gap, so the distance from checkbox to bubble is the distance the bubble had
  // from the edge. A margin on the scroller, so rows React positions inside it (absolutely, by
// transform) move with it.
  + 'var GUTTER=42;var gutter=function(on){var sc=scroller();if(!sc)return;if(on){if(sc.__sandPad==null)sc.__sandPad=sc.style.marginLeft||"";sc.style.marginLeft=GUTTER+"px"}else if(sc.__sandPad!=null){sc.style.marginLeft=sc.__sandPad;sc.__sandPad=null}};'
  + 'var placeBar=function(){var sc=scroller();if(!sc)return;var col=column();var cr=col.getBoundingClientRect();var hd=document.querySelector("header.sand-toolbar");var hr=hd?hd.getBoundingClientRect():null;bar.style.top=(hr?hr.top:0)+"px";bar.style.height=(hr&&hr.height>=36?hr.height:44)+"px";bar.style.left=cr.left+"px";bar.style.width=cr.width+"px"};'
  + 'var lastSig="";var sig=function(){var l=loadedIds();var n=0;l.forEach(function(i){if(st.ids.has(i))n++});return l.length+":"+n+":"+st.ids.size};'
  + 'var raf=0;var paint=function(){raf=0;if(!st.on){layer.hidden=true;return}if(st.agent&&agentIdNow()&&agentIdNow()!==st.agent){api.exit();return}var s=sig();if(s!==lastSig){lastSig=s;renderBar()}layer.hidden=false;layer.textContent="";placeBar();gutter(true);var sc=scroller();if(!sc)return;var vr=sc.getBoundingClientRect();var barBottom=bar.getBoundingClientRect().bottom;rows().forEach(function(row){var ids=idsOf(row);var r=row.getBoundingClientRect();if(r.bottom<Math.max(vr.top,barBottom)||r.top>vr.bottom||r.height<8)return;var on=ids.every(function(i){return st.ids.has(i)});var c=document.createElement("div");c.className="sand-sel-box"+(on?" on":"");var bt=r.top+(r.height<=64?Math.max(4,r.height/2-9):14);if(bt<barBottom+4)bt=barBottom+4;if(bt>r.bottom-18)return;c.style.left=(colLeft()+12)+"px";c.style.top=bt+"px";layer.appendChild(c)})};'
  + 'var queue=function(){raf||(raf=requestAnimationFrame(paint))};'
  + 'var iconButton=function(name,label,fn,cls){var b=document.createElement("button");b.type="button";b.innerHTML=ICON[name];b.setAttribute("aria-label",label);b.title=label;cls&&b.classList.add(cls);b.addEventListener("click",function(ev){ev.stopPropagation();fn()});bar.appendChild(b);return b};'
  + 'var textButton=function(label,fn,cls){var b=document.createElement("button");b.type="button";b.className="sand-sel-text"+(cls?" "+cls:"");b.textContent=label;b.addEventListener("click",function(ev){ev.stopPropagation();fn()});bar.appendChild(b);return b};'
  + 'var note=function(text,cls){var s=document.createElement("span");s.className=cls||"sand-sel-note";s.textContent=text;bar.appendChild(s);return s};'
  // The toolbar: [master checkbox] N selected · M loaded ……… share · bookmark · delete · close
  + 'var renderBar=function(msg){if(!st.on){bar.hidden=true;return}bar.hidden=false;bar.textContent="";placeBar();lastSig=sig();var n=st.ids.size;'
  + 'if(msg){note(msg,"sand-sel-count");var sp=document.createElement("span");sp.className="sand-sel-spacer";bar.appendChild(sp);iconButton("x","Done",function(){api.exit()});return}'
  + 'var loaded=loadedIds();var fresh=loaded.filter(function(i){return!st.ids.has(i)});'
  // The left control adds; it never removes, so it cannot lock. When every loaded message is
  // already in, it says so instead of turning into a trap.
  + 'var add=document.createElement("button");add.type="button";add.className="sand-sel-add";add.disabled=fresh.length===0;add.setAttribute("aria-label",fresh.length>0?"Add the "+fresh.length+" loaded messages to the selection":"Every loaded message is already selected");add.title=add.getAttribute("aria-label");var plus=document.createElement("span");plus.className="sand-sel-plus";plus.setAttribute("aria-hidden","true");add.appendChild(plus);var addLabel=document.createElement("span");addLabel.textContent=fresh.length>0?"Add "+fresh.length+" loaded":"All loaded added";add.appendChild(addLabel);add.addEventListener("click",function(ev){ev.stopPropagation();api.addLoaded()});bar.appendChild(add);'
  + 'note(n+" selected","sand-sel-count");'
  + 'if(n>0){var clear=document.createElement("button");clear.type="button";clear.className="sand-sel-text sand-sel-clear";clear.textContent="Clear";clear.setAttribute("aria-label","Clear the selection");clear.addEventListener("click",function(ev){ev.stopPropagation();api.selectNone()});bar.appendChild(clear)}'
  + 'if(loaded.length)note("\\u00b7 "+loaded.length+" loaded, scroll for more");'
  + 'var sp=document.createElement("span");sp.className="sand-sel-spacer";bar.appendChild(sp);'
  + 'var col=window.desktop&&window.desktop.collections;'
  + 'if(col&&col.addMessages){iconButton("share","Share to a collection",function(){picker()}).disabled=!n;iconButton("star","Bookmark",function(){act("bookmark")}).disabled=!n}'
  + 'var del=window.desktop&&window.desktop.agent&&window.desktop.agent.deleteTranscriptEntries;'
  + 'iconButton("trash",self.__sandDeleteAvailable===!0?"Delete":"Hide on this device",function(){confirmDelete()},"sand-sel-danger").disabled=!del||!n;'
  + 'iconButton("x","Done",function(){api.exit()})};'
  + 'var confirmDelete=function(){var n=st.ids.size;bar.textContent="";placeBar();var server=self.__sandDeleteAvailable===!0;note(server?"Delete "+n+" message"+(n===1?"":"s")+" for everyone on this server?":"Hide "+n+" message"+(n===1?"":"s")+" on this device? The server copy is unchanged.","sand-sel-count");var sp=document.createElement("span");sp.className="sand-sel-spacer";bar.appendChild(sp);textButton(server?"Delete":"Hide",function(){doDelete()},"sand-sel-danger");textButton("Back",function(){renderBar()})};'
  + 'var bounce=function(ag){try{var items=document.querySelectorAll(".sand-agent-item[data-agent-id]");var cur=null,other=null;items.forEach(function(r){var id=r.getAttribute("data-agent-id");if(id===ag)cur=r;else if(!other)other=r});if(cur&&other){other.click();setTimeout(function(){cur.click()},400)}}catch(_){}};'
  // The server answers with a count, the local router with the ids; either way what was not
  // deleted stays selected and is said. Hiding on this device is only for a route where nothing
  // can delete (Cursor's remote box); a failure anywhere else is a failure, said as one.
  + 'var doDelete=function(){var ag=agentIdNow();if(!ag){renderBar("No active agent detected");setTimeout(function(){renderBar()},2500);return}var ids=Array.from(st.ids);var server=self.__sandDeleteAvailable===!0;renderBar(server?"Deleting\\u2026":"Hiding\\u2026");window.desktop.agent.deleteTranscriptEntries({agentId:ag,entryIds:ids}).then(function(res){var blocked=(res&&res.blocked)||[];var del;if(res&&Array.isArray(res.deleted))del=res.deleted;else if(res&&typeof res.deleted==="number")del=res.deleted>=ids.length?ids:[];else del=[];var n=res&&typeof res.deleted==="number"?res.deleted:del.length;del.forEach(function(i){st.ids.delete(i)});if(blocked.length){renderBar(n+" deleted \\u00b7 "+blocked.length+" blocked ("+blocked.map(function(b){return b.reason}).filter(function(v,i,a){return a.indexOf(v)===i}).join(", ")+")");setTimeout(function(){st.ids.size?renderBar():api.exit()},3200)}else if(n>=ids.length){api.exit()}else if(n>0){renderBar("Deleted "+n+" of "+ids.length+"; the rest are still selected.");setTimeout(function(){renderBar()},3000)}else{renderBar("Nothing was deleted; the server refused.");setTimeout(function(){renderBar()},3000)}queue()}).catch(function(e){if(server){renderBar("Couldn\\u2019t delete: "+(e&&e.message?e.message:"the server did not answer")+".");setTimeout(function(){renderBar()},3000);return}window.__sandTombstones.add(ag,ids);renderBar("Hidden on this device (remote agent \\u2014 the server copy is unchanged)");setTimeout(function(){api.exit();bounce(ag)},1600)})};'
  + 'var send=function(extra,label){var ag=agentIdNow();var ids=Array.from(st.ids);var col=window.desktop&&window.desktop.collections;if(!col||!col.addMessages)return;if(!ag){renderBar("No active agent detected");setTimeout(function(){renderBar()},2500);return}if(!ids.length){renderBar("Choose at least one message first.");setTimeout(function(){renderBar()},2500);return}renderBar(label);var req={agentId:ag,entryIds:ids};for(var k in extra)req[k]=extra[k];col.addMessages(req).then(function(){renderBar(label.replace(/\\u2026$/,"")==="Bookmarking"?"Bookmarked "+ids.length+".":"Added "+ids.length+".");setTimeout(function(){api.exit()},1200)}).catch(function(e){renderBar("Failed: "+(e&&e.message||e));setTimeout(function(){renderBar()},3000)})};'
  + 'var act=function(kind){send({target:"bookmarks"},"Bookmarking\\u2026")};'
  + 'var picker=function(){var col=window.desktop&&window.desktop.collections;if(!col||!col.list){send({},"Sharing\\u2026");return}bar.textContent="";placeBar();note("Add "+st.ids.size+" to\\u2026","sand-sel-count");'
  + 'col.list().then(function(r){var cols=(r&&r.collections)||[];cols.slice(0,6).forEach(function(c){textButton(c.name+" ("+(c.count||0)+")",function(){send(c.id==="bookmarks"?{target:"bookmarks"}:{collectionId:c.id},"Sharing\\u2026")})});'
  + 'textButton("New collection\\u2026",function(){bar.textContent="";placeBar();note("Name:","sand-sel-count");var inp=document.createElement("input");inp.type="text";inp.placeholder="Collection name";inp.addEventListener("keydown",function(ev){ev.stopPropagation();if(ev.key==="Enter"&&inp.value.trim())send({name:inp.value.trim()},"Sharing\\u2026");if(ev.key==="Escape")renderBar()});bar.appendChild(inp);textButton("Create",function(){inp.value.trim()&&send({name:inp.value.trim()},"Sharing\\u2026")});textButton("Back",function(){picker()});inp.focus()});'
  + 'var sp=document.createElement("span");sp.className="sand-sel-spacer";bar.appendChild(sp);iconButton("x","Back",function(){renderBar()})}).catch(function(){send({},"Sharing\\u2026")})};'
  + 'var onClick=function(ev){if(!st.on)return;if(bar.contains(ev.target))return;var sc=scroller();if(!sc||!sc.contains(ev.target))return;ev.preventDefault();ev.stopPropagation();var row=ev.target&&ev.target.closest?ev.target.closest("[data-row-key]"):null;var ids=idsOf(row);if(!ids.length)return;var idx=row.getAttribute("data-index");if(ev.shiftKey&&st.anchor!=null&&idx!=null){var lo=Math.min(st.anchor,+idx),hi=Math.max(st.anchor,+idx);rows().forEach(function(r){var i=+r.getAttribute("data-index");if(i>=lo&&i<=hi)idsOf(r).forEach(function(x){st.ids.add(x)})})}else{var on=ids.every(function(i){return st.ids.has(i)});ids.forEach(function(i){on?st.ids.delete(i):st.ids.add(i)});if(idx!=null)st.anchor=+idx}renderBar();queue()};'
  + 'var onKey=function(ev){if(!st.on)return;if(ev.key==="Escape"){if(ev.target&&(/^(INPUT|TEXTAREA)$/.test(ev.target.tagName)||ev.target.isContentEditable))return;if(document.querySelector("[role=menu],[role=dialog],[role=alertdialog]:not(.sand-delete-confirm)"))return;ev.preventDefault();ev.stopPropagation();api.exit()}else if((ev.metaKey||ev.ctrlKey)&&(ev.key==="a"||ev.key==="A")&&!(ev.target&&/^(INPUT|TEXTAREA)$/.test(ev.target.tagName))&&!(ev.target&&ev.target.isContentEditable)){ev.preventDefault();ev.stopPropagation();api.addLoaded()}};'
  + 'document.addEventListener("keydown",function(ev){if((ev.metaKey||ev.ctrlKey)&&ev.shiftKey&&(ev.key==="A"||ev.key==="a")&&!st.on&&scroller()){ev.preventDefault();api.enter()}},true);'
  + 'var iv=0;var mo=new MutationObserver(queue);'
  + 'var api={active:function(){return st.on},count:function(){return st.ids.size},ids:function(){return Array.from(st.ids)},idsOf:idsOf,entryIdOf:entryIdOf,'
  + 'enter:function(seed){if(st.on)return;st.on=true;st.ids=new Set();st.anchor=null;st.agent=agentIdNow()||null;if(seed!=null&&String(seed).length>0)st.ids.add(String(seed));var sc=scroller();sc&&mo.observe(sc,{childList:true,subtree:true,attributes:true,attributeFilter:["style"]});iv=setInterval(queue,300);document.addEventListener("click",onClick,true);document.addEventListener("keydown",onKey,true);document.addEventListener("scroll",queue,true);window.addEventListener("resize",queue);renderBar();queue()},'
  + 'exit:function(){if(!st.on)return;st.on=false;st.ids.clear();st.agent=null;lastSig="";gutter(false);mo.disconnect();clearInterval(iv);document.removeEventListener("click",onClick,true);document.removeEventListener("keydown",onKey,true);document.removeEventListener("scroll",queue,true);window.removeEventListener("resize",queue);bar.hidden=true;layer.hidden=true;layer.textContent=""},'
  + 'toggle:function(id){st.ids.has(id)?st.ids.delete(id):st.ids.add(id);renderBar();queue()},'
  + 'paint:paint,'
  + 'addLoaded:function(){loadedIds().forEach(function(i){st.ids.add(i)});renderBar();queue()},'
  + 'selectNone:function(){st.ids.clear();renderBar();queue()}};'
  + 'window.__sandSelect=api'
  + '}catch(_){}})();\n';
