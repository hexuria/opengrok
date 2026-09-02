export const SAND_PRODUCT_DISPLAY_NAME = "Grok Bot";
export const SAND_PRODUCT_HTTP_TOKEN = SAND_PRODUCT_DISPLAY_NAME.replaceAll(/\s+/g, "");

/** What the app calls itself in front of the person: the official name on Cursor, ours on an OpenGrok server. */
export type SandProductBrand = "Grok Bot" | "Open Grok";
export const OPENGROK_PRODUCT_DISPLAY_NAME: SandProductBrand = "Open Grok";

let currentBrand: SandProductBrand = SAND_PRODUCT_DISPLAY_NAME;

/** The settings store calls this whenever it reads or writes the box runtime, so every process follows the sign-in. */
export function setProductBrandForBoxRuntime(boxRuntime: unknown): SandProductBrand {
  currentBrand = boxRuntime === "opengrok" ? OPENGROK_PRODUCT_DISPLAY_NAME : SAND_PRODUCT_DISPLAY_NAME;
  return currentBrand;
}

export function productDisplayName(): SandProductBrand {
  return currentBrand;
}

/** Rewrites "Grok Bot" in user-facing copy to the current brand. Text naming the official product should not pass through here. */
export function brandText(text: string): string {
  return currentBrand === SAND_PRODUCT_DISPLAY_NAME ? text : text.replaceAll(SAND_PRODUCT_DISPLAY_NAME, currentBrand);
}

export function resetProductBrandForTests(): void {
  currentBrand = SAND_PRODUCT_DISPLAY_NAME;
}
