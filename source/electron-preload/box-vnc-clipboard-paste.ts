export function isHostPasteKey(event: {
  readonly key?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
}): boolean {
  if (event.key !== "v" && event.key !== "V") return false;
  if (event.altKey === true) return false;
  return event.metaKey === true || event.ctrlKey === true;
}

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

export function buildHostClipboardPasteAndKeyScript(text: string): string {
  const encodedText = JSON.stringify(text);
  return `
    import("./app/ui.js")
      .then(function (m) {
        var rfb = m && m.default && m.default.rfb;
        var text = ${encodedText};
        if (!rfb) return false;
        if (typeof rfb.clipboardPasteFrom === "function" && text) {
          rfb.clipboardPasteFrom(text);
        }
        if (typeof rfb.sendKey !== "function") return false;
        var CONTROL_L = 0xffe3;
        var KEY_V = 0x76;
        var HELD_MODIFIERS = [
          [0xffe7, "MetaLeft"], [0xffe8, "MetaRight"],
          [0xffe9, "AltLeft"], [0xffea, "AltRight"],
          [0xffeb, "SuperLeft"], [0xffec, "SuperRight"]
        ];
        for (var i = 0; i < HELD_MODIFIERS.length; i++) {
          try { rfb.sendKey(HELD_MODIFIERS[i][0], HELD_MODIFIERS[i][1], false); } catch (_e) {}
        }
        rfb.sendKey(CONTROL_L, "ControlLeft", true);
        rfb.sendKey(KEY_V, "KeyV", true);
        rfb.sendKey(KEY_V, "KeyV", false);
        rfb.sendKey(CONTROL_L, "ControlLeft", false);
        return true;
      })
      .catch(function () {
        return false;
      });
  `;
}

export function resolveHostToBoxSync(text: string, didPaste: boolean): string | null {
  return didPaste && text.length > 0 ? text : null;
}
