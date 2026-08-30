const knownLogoUrls = new Set<string>();
export function rememberPluginLogoUrl(url: string): void { knownLogoUrls.add(url); }
export function isKnownPluginLogoUrl(url: string): boolean { return knownLogoUrls.has(url); }
