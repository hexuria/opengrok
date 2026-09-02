// The coworker's screen, in the shape it actually is.
//
// The preview frame is a fixed 16:10 box with a filled grey ground, and the remote desktop is
// scaled to fit inside it. When the machine's own resolution is not 16:10 the screen letterboxes
// and that grey shows around it as a slab, which reads as a broken image rather than a screen of
// a different shape. The fill goes; what is left is a hairline edge, so a letterboxed screen sits
// on the pane's own ground and the frame still has an outline while the machine is connecting.

export const SCREEN_PREVIEW_HELPER =
  ';(()=>{try{'
  + 'var css=document.createElement("style");css.textContent='
  + '".sand-computer-preview__frame{background-color:transparent!important;box-shadow:inset 0 0 0 1px rgba(127,127,127,.22)}"'
  + '+".sand-computer-preview__frame>*{border-radius:inherit}";'
  + '(document.head||document.documentElement).appendChild(css);'
  + '}catch(_){}})();';
