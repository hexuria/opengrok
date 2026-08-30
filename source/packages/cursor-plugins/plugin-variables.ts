export function expandPluginVariables(value: string, pluginPath: string): string {
  return value
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => pluginPath)
    .replace(/\$\{CURSOR_PLUGIN_ROOT\}/g, () => pluginPath);
}
