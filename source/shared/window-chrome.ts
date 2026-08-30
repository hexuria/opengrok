export const MAC_TRAFFIC_LIGHT_POSITION = { x: 16, y: 15 } as const;
export const WINDOWS_TITLEBAR_BLOCK_PX = 52;
export const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT_PX = WINDOWS_TITLEBAR_BLOCK_PX - 1;
export const WINDOWS_COMPUTER_TOP_BAR_PX = 44;
export const WINDOWS_COMPUTER_TITLE_BAR_OVERLAY_HEIGHT_PX =
  WINDOWS_COMPUTER_TOP_BAR_PX - 1;

function parseHexRgb(backgroundHex: string): [number, number, number] | undefined {
  if (!/^#[0-9A-Fa-f]{6}$/.test(backgroundHex)) return undefined;
  const hex = backgroundHex.slice(1);
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

export function blendRgbaOverHex(
  rgb: readonly [number, number, number],
  alpha: number,
  backgroundHex: string,
): string {
  const background = parseHexRgb(backgroundHex) ?? [24, 24, 24];
  return `#${toHexByte(Math.round(rgb[0] * alpha + background[0] * (1 - alpha)))}${toHexByte(
    Math.round(rgb[1] * alpha + background[1] * (1 - alpha)),
  )}${toHexByte(Math.round(rgb[2] * alpha + background[2] * (1 - alpha)))}`;
}

export function windowsTitleBarOverlayHeight(isOverlayTone: boolean): number {
  return isOverlayTone
    ? WINDOWS_COMPUTER_TITLE_BAR_OVERLAY_HEIGHT_PX
    : WINDOWS_TITLE_BAR_OVERLAY_HEIGHT_PX;
}

export function windowsTitleBarOverlayBackground(
  themeBackground: string,
  isOverlayTone: boolean,
): string {
  if (!isOverlayTone) return themeBackground;
  const cover = blendRgbaOverHex([20, 20, 20], 0.95, themeBackground);
  return blendRgbaOverHex([0, 0, 0], 0.55, cover);
}

export function titleBarOverlaySymbolColor(backgroundHex: string): string {
  const [red, green, blue] = parseHexRgb(backgroundHex) ?? [24, 24, 24];
  return (red * 299 + green * 587 + blue * 114) / 1_000 < 128
    ? "#FFFFFF"
    : "#000000";
}
