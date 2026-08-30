export const isOriginGitHost = (host: string): boolean => /^origin(-[a-z0-9]+)?\.cursor\.com$/i.test(host);
