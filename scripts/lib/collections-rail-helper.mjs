// The way into the archive. The rail holds coworkers and, at its foot, the app's own controls;
// saved messages had no entry there at all — the Collections window only opened from a link or
// right after a save, so a collection you made was hard to find again.
//
// The rail is React's, so nothing is written into its list: the button is placed beside the
// "New" control at the foot and put back if a re-render drops it. The glyph is the same stack
// of cards the selection toolbar uses for "save to a collection", so one shape means one thing.

export const COLLECTIONS_RAIL_HELPER =
  ';(()=>{try{'
  + 'var css=document.createElement("style");css.textContent='
  + '".sand-collections-entry{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:0;border-radius:9px;background:transparent;color:currentColor;cursor:pointer;opacity:.75}"'
  + '+".sand-collections-entry:hover{opacity:1;background:rgba(127,127,127,.18)}"'
  + '+".sand-collections-entry svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}";'
  + 'document.head.appendChild(css);'
  + 'var ICON=\'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="9" width="14" height="11" rx="2.5"/><path d="M6.5 6h11a2.5 2.5 0 0 1 2.5 2.5v9"/><path d="M9.5 3h8A3.5 3.5 0 0 1 21 6.5v8"/></svg>\';'
  // The foot of the rail: the "New" control. Ours sits just above it, so coworkers stay
  // together and the app's own entries stay together.
  // The rail keeps a hidden copy of its foot for another layout, so the anchor must be the
  // control a person can actually see.
  + 'var anchor=function(){var buttons=document.querySelectorAll("button");for(var i=0;i<buttons.length;i++){var b=buttons[i];var label=b.getAttribute("aria-label")||"";if(label!=="New")continue;var r=b.getBoundingClientRect();if(r.width>0&&r.height>0&&r.left<120&&r.width<70&&r.height<70)return b}return null};'
  + 'var make=function(){var b=document.createElement("button");b.type="button";b.className="sand-collections-entry";b.innerHTML=ICON;b.setAttribute("aria-label","Collections");b.title="Collections";'
  + 'b.addEventListener("click",function(ev){ev.preventDefault();ev.stopPropagation();try{var d=window.desktop&&window.desktop.agent;if(d&&typeof d.openCollections==="function")d.openCollections()}catch(_){}});'
  + 'return b};'
  + 'var entry=null;'
  + 'var place=function(){try{var host=anchor();if(!host||!host.parentElement)return;if(entry&&entry.isConnected&&entry.parentElement===host.parentElement&&entry.getBoundingClientRect().width>0)return;if(!entry)entry=make();host.parentElement.insertBefore(entry,host)}catch(_){}};'
  + 'place();'
  + 'var mo=new MutationObserver(function(){place()});'
  + 'try{mo.observe(document.body,{childList:!0,subtree:!0})}catch(_){}'
  + 'setInterval(place,2000);'
  + '}catch(_){}})();';
