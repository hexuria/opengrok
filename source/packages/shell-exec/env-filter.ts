export const SOCKET_ENV_VARS_TO_SCRUB = ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY"] as const;
export function filterElectronEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _discarded, ...filteredEnv } = env || process.env;
  return filteredEnv;
}
export function scrubSocketEnvVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of SOCKET_ENV_VARS_TO_SCRUB) delete result[key];
  return result;
}
