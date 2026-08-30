export interface WindowShortcutInput {
  readonly type: string;
  readonly key: string;
  readonly meta?: boolean;
  readonly control?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export type WindowShortcut = "fullscreen" | "toggledevtools" | "reload" | "quit";

export function classifyWindowShortcut(input: WindowShortcutInput, platform: NodeJS.Platform): WindowShortcut | null {
  if (input.type !== "keyDown") return null;
  const key = input.key.toLowerCase();
  if (key === "f11") return "fullscreen";
  const isMac = platform === "darwin";
  if (isMac && input.meta && input.control && key === "f") return "fullscreen";
  if (key === "f12") return "toggledevtools";
  if (isMac && input.meta && input.alt && key === "i") return "toggledevtools";
  if (!isMac && input.control && input.shift && !input.alt && !input.meta && key === "i") return "toggledevtools";
  const mod = isMac ? input.meta : input.control;
  if (!mod || input.alt) return null;
  if (key === "r" && !input.shift) return "reload";
  if (key === "q") return "quit";
  return null;
}
