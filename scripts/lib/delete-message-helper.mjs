// "Delete message" in the message menu. The menu item itself is a native It.Item added in the
// router patch (MENU_COPY_ID_AFTER); it calls `__sandDeleteMessage(id, agentHint)` here, which
// asks once, inside the transcript row, before going through `desktop.agent.deleteTranscriptEntries`.
// Rows are found by the entry id in their `aria-labelledby` (`sand-conversation-entry-<id>-author …`,
// on every live row; `data-row-key` is the client nonce on the person's own messages and
// `data-entry-id` is set on only some rows) so the question lands on the bubble it is about.
// The row disappears when the `removed` frame comes back over the stream; nothing here removes
// it by hand, so what the person sees is what the server did. The item only exists on routes
// that can delete (`desktop.agent.getTranscriptDeletion`), asked once at boot.

export const DELETE_MESSAGE_HELPER =
  ';(()=>{try{'
  + 'var css=".sand-delete-confirm{display:flex;gap:10px;align-items:center;margin:6px 0;padding:8px 12px;border-radius:8px;background:#7a2e0e;color:#fff;font:13px/1.4 -apple-system,system-ui,sans-serif}'
  + '.sand-delete-confirm button{border:0;border-radius:4px;padding:4px 10px;font:inherit;font-weight:600;cursor:pointer;background:#fff;color:#7a2e0e}'
  + '.sand-delete-confirm button.sand-delete-cancel{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6)}";'
  + 'var st=document.createElement("style");st.textContent=css;(document.head||document.documentElement).appendChild(st);'
  + 'var d=window.desktop&&window.desktop.agent;'
  + 'self.__sandDeleteAvailable=!1;'
  // Asked at boot and again, at most every five seconds, whenever a message menu is built, so a
  // route change reaches the menu without a relaunch and a menu opened before the first answer
  // is right the next time it opens.
  + 'var askedAt=0;var ask=function(){if(!d||typeof d.getTranscriptDeletion!=="function")return;var now=Date.now();if(now-askedAt<5000)return;askedAt=now;d.getTranscriptDeletion().then(function(r){self.__sandDeleteAvailable=!!(r&&r.available===!0)}).catch(function(){})};'
  + 'self.__sandDeleteRefresh=ask;ask();'
  + 'var open=null;'
  + 'var close=function(){if(open){open.remove();open=null}};'
  + 'var agentOf=function(hint){if(hint)return String(hint);try{var a=self.__sandCurrentAgent&&self.__sandCurrentAgent();if(a)return a}catch(_){}var it=document.querySelector(\'.sand-agent-item[aria-current="page"]\');return it?it.getAttribute("data-agent-id")||"":""};'
  // The transcript's own row first (a thread panel or a quote can show the same entry), by the
  // entry id in aria-labelledby; data-row-key is the nonce on the person's own rows.
  + 'var findRow=function(id){var q=JSON.stringify(id),lab=JSON.stringify("sand-conversation-entry-"+id+"-");var sels=[".sand-virtual-transcript .sand-transcript-row[aria-labelledby*="+lab+"]",".sand-virtual-transcript [data-entry-id="+q+"]",".sand-transcript-row[aria-labelledby*="+lab+"]","[data-entry-id="+q+"]",".sand-transcript-row[data-row-key="+q+"]"];for(var i=0;i<sels.length;i++){var el=document.querySelector(sels[i]);if(el)return el}return null};'
  // A row is React's; it may re-render or scroll out while the question is up. The strip is
  // put back on the row it belongs to whenever it has something new to say.
  + 'var place=function(box,id){if(box.isConnected)return!0;var row=findRow(id);if(!row)return!1;row.appendChild(box);return!0};'
  + 'self.__sandDeleteMessage=function(id,hint){id=String(id||"");if(!id)return!1;var row=findRow(id);if(!row)return!1;close();'
  + 'var box=document.createElement("div");box.className="sand-delete-confirm";box.setAttribute("role","alertdialog");box.setAttribute("aria-label","Delete this message?");'
  + 'var s=document.createElement("span");'
  + 'var ok=document.createElement("button");ok.type="button";ok.textContent="Delete";'
  + 'var no=document.createElement("button");no.type="button";no.className="sand-delete-cancel";no.textContent="Cancel";'
  + 'no.addEventListener("click",close);'
  + 'if(row.hasAttribute("data-pending")){s.textContent="This message hasn’t reached the server yet; there is nothing to delete there.";no.textContent="OK";box.appendChild(s);box.appendChild(no);row.appendChild(box);open=box;return!0}'
  + 's.textContent="Delete this message?";'
  + 'ok.addEventListener("click",function(){ok.disabled=!0;s.textContent="Deleting…";var agentId=agentOf(hint);'
  + 'if(!d||typeof d.deleteTranscriptEntries!=="function"||!agentId){s.textContent="Couldn’t delete: no route to the server.";ok.remove();place(box,id);return}'
  + 'd.deleteTranscriptEntries({agentId:agentId,entryIds:[id]}).then(function(r){'
  + 'var n=r&&typeof r.deleted==="number"?r.deleted:Array.isArray(r&&r.deleted)?r.deleted.length:0;'
  + 'if(n>0){close();return}'
  + 'var why=r&&Array.isArray(r.blocked)&&r.blocked[0]&&r.blocked[0].reason?r.blocked[0].reason:"the server refused";'
  + 's.textContent="Couldn’t delete: "+why+".";ok.remove();place(box,id)'
  + '}).catch(function(e){s.textContent="Couldn’t delete: "+(e&&e.message?e.message:"the server did not answer")+".";ok.remove();place(box,id)})});'
  + 'box.appendChild(s);box.appendChild(ok);box.appendChild(no);row.appendChild(box);open=box;try{ok.focus()}catch(_){}return!0};'
  + 'document.addEventListener("keydown",function(ev){if(ev.key==="Escape"&&open)close()});'
  + '}catch(_){}})();';
