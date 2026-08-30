export const SAND_THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type SandThemePreference = (typeof SAND_THEME_PREFERENCES)[number];
export const DEFAULT_SAND_THEME_PREFERENCE: SandThemePreference = "system";
export function isSandThemePreference(value: unknown): value is SandThemePreference { return typeof value === "string" && (SAND_THEME_PREFERENCES as readonly string[]).includes(value); }
export function isSandDeepLinkPluginId(value: unknown): value is string { return typeof value === "string" && /^[0-9]{1,19}$/.test(value); }
export const SAND_PLUGIN_DEEP_LINK_PATH = "/v1/plugin/add";
export function buildSandPluginDeepLink(pluginId: string): string { return `sand://app${SAND_PLUGIN_DEEP_LINK_PATH}?id=${encodeURIComponent(pluginId)}`; }
