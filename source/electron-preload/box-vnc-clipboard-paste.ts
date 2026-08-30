export function buildHostClipboardPasteScript(text: string): string {
  const encodedText = JSON.stringify(text);
  return `
    import("./app/ui.js")
      .then(function (m) {
        var rfb = m && m.default && m.default.rfb;
        var text = ${encodedText};
        if (rfb && typeof rfb.clipboardPasteFrom === "function" && text) {
          rfb.clipboardPasteFrom(text);
          return true;
        }
        return false;
      })
      .catch(function () {
        return false;
      });
  `;
}

export function resolveHostToBoxSync(text: string, didPaste: boolean): string | null {
  return didPaste && text.length > 0 ? text : null;
}
