// When the server cannot answer, the coordinator serves the last good roster and transcripts and
// says so on `coordinator-server-reads`. The preload hands that state to the page through
// `desktop.agent.onServerReads`; this helper paints it as a banner over the roster, with a Retry.
// Nothing here touches the transport state, which gates outgoing sends.

/** The banner's words, pure, so a test can pin them without a DOM. */
export const SERVER_READS_TEXT_SOURCE =
  'function __sandServerReadsText(p){'
  + 'if(!p||p.state!=="stale")return null;'
  + 'var when="";try{if(p.cachedAt)when=new Date(p.cachedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}catch(_){}'
  + 'return p.cached'
  + '?"Your server can’t be reached. Showing what was loaded"+(when?" at "+when:" earlier")+"; new messages and changes will not appear until it is back."'
  + ':"Your server can’t be reached, and nothing from it has loaded yet."}';

export const SERVER_READS_BANNER_HELPER =
  ';(()=>{try{' + SERVER_READS_TEXT_SOURCE
  + 'var el=null;'
  + 'var css=".sand-server-reads{position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;gap:12px;align-items:center;justify-content:center;padding:8px 14px;background:#7a2e0e;color:#fff;font:13px/1.45 -apple-system,system-ui,sans-serif}'
  + '.sand-server-reads button{background:#fff;color:#7a2e0e;border:0;border-radius:4px;padding:4px 10px;font:inherit;font-weight:600;cursor:pointer}";'
  + 'var st=document.createElement("style");st.textContent=css;(document.head||document.documentElement).appendChild(st);'
  + 'var wasStale=!1,hadCache=!1;'
  + 'var draft=function(){var pm=document.querySelector(".ProseMirror");return !!(pm&&pm.textContent&&pm.textContent.trim())};'
  + 'var render=function(p){var text=__sandServerReadsText(p);'
  + 'if(text===null){'
  // Reads are live again. A page that was left empty by the outage (a reload that found
  // nothing to show) has no roster to refresh from; a reload now paints the live one. Only
  // when there was a roster to show (an account with no coworkers is not empty by accident),
  // and never over a draft the person is typing.
  + 'if(wasStale&&hadCache&&el&&!draft()&&!document.querySelector(".sand-agent-item[data-agent-id]")){el.textContent="Your server is back; refreshing.";setTimeout(function(){location.reload()},800);wasStale=!1;return}'
  + 'wasStale=!1;if(el){el.remove();el=null}return}'
  + 'wasStale=!0;hadCache=!!p.cached;'
  + 'if(!el){el=document.createElement("div");el.className="sand-server-reads";el.setAttribute("role","status");document.body.appendChild(el)}'
  + 'el.textContent="";var s=document.createElement("span");s.textContent=text;var b=document.createElement("button");b.type="button";b.textContent="Retry";'
  + 'b.addEventListener("click",function(){location.reload()});el.appendChild(s);el.appendChild(b)};'
  + 'var a=window.desktop&&window.desktop.agent;'
  + 'if(a&&typeof a.onServerReads==="function")a.onServerReads(render);'
  + '}catch(_){}})();';
