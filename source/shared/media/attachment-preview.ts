import { attachmentExtension } from "./attachment-open-policy.js";

export const TEXT_PREVIEWABLE_EXTENSIONS = new Set([
  "txt", "text", "log", "md", "markdown", "mdx", "rst", "adoc", "tex", "json", "jsonc",
  "json5", "ndjson", "csv", "tsv", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "env", "properties", "plist", "gradle", "html", "htm", "css", "scss", "sass", "less", "svg",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "py", "pyi", "rb", "go", "rs",
  "java", "kt", "kts", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "php", "swift",
  "scala", "dart", "lua", "pl", "pm", "r", "sql", "graphql", "gql", "proto", "vue", "svelte",
  "astro", "sh", "bash", "zsh", "fish", "bat", "ps1", "tf", "tfvars", "dockerfile", "diff", "patch",
]);

export function isTextPreviewableName(nameOrPath: string): boolean {
  const extension = attachmentExtension(nameOrPath);
  return extension != null && TEXT_PREVIEWABLE_EXTENSIONS.has(extension);
}

export const BINARY_SNIFF_BYTE_WINDOW = 8 * 1024;
export const BINARY_CONTROL_BYTE_RATIO = 0.3;

export function looksLikeBinary(bytes: Uint8Array): boolean {
  const sample = bytes.byteLength > BINARY_SNIFF_BYTE_WINDOW
    ? bytes.subarray(0, BINARY_SNIFF_BYTE_WINDOW)
    : bytes;
  if (sample.byteLength === 0) return false;
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    const isTextWhitespace = byte >= 9 && byte <= 13;
    if (byte < 32 && !isTextWhitespace) controlBytes += 1;
  }
  return controlBytes / sample.byteLength > BINARY_CONTROL_BYTE_RATIO;
}
