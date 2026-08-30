export const DEFAULT_DEV_CONTROL_PORT = 62_150;
export function isDevControlsEnabled(options: { readonly isPackaged: boolean }): boolean { return !options.isPackaged; }
export function resolveDevControlPort(env: NodeJS.ProcessEnv = process.env): number { const port = Number(env.SAND_DEV_CONTROL_PORT); return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_DEV_CONTROL_PORT; }
