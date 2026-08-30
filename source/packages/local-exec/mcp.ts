const logger = { name: "local-exec:mcp" };

export function sanitizeServerName(name: string): string {
  const sanitized = name.replace(/\s/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "");
  const normalizedDots = sanitized.replace(/\.+/g, ".");
  if (normalizedDots === "." || normalizedDots === "..") return normalizedDots.replace(/\./g, "_");
  return normalizedDots.length === 0 ? "_" : normalizedDots;
}
