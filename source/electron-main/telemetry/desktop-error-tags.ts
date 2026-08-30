export type DesktopErrorCode = "SAND-E0601" | "SAND-E0602" | "SAND-E0603" | "SAND-E0604" | "SAND-E0605" | "SAND-E0606" | "SAND-E0607" | "SAND-E0610";

const DEFINITIONS: Record<DesktopErrorCode, { readonly retryable: boolean; readonly payload: readonly string[] }> = {
  "SAND-E0601": { retryable: false, payload: ["phase"] },
  "SAND-E0602": { retryable: true, payload: ["phase"] },
  "SAND-E0603": { retryable: false, payload: [] },
  "SAND-E0604": { retryable: false, payload: [] },
  "SAND-E0605": { retryable: true, payload: ["process", "reason"] },
  "SAND-E0606": { retryable: true, payload: ["leg"] },
  "SAND-E0607": { retryable: true, payload: ["timeoutMs"] },
  "SAND-E0610": { retryable: false, payload: [] },
};
const BOUNDED_TAG_VALUE = /^[0-9A-Za-z._|:/ -]{1,128}$/;

export function desktopErrorTags(code: DesktopErrorCode, payload: Readonly<Record<string, unknown>> = {}): Record<string, string> {
  const definition = DEFINITIONS[code];
  const tags: Record<string, string> = { error_code: code, error_domain: "desktop", error_retryable: String(definition.retryable) };
  for (const field of definition.payload) {
    const value = payload[field];
    const tag = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (typeof value === "number" && Number.isFinite(value)) tags[tag] = String(value);
    else if (typeof value === "boolean") tags[tag] = String(value);
    else if (typeof value === "string" && BOUNDED_TAG_VALUE.test(value)) tags[tag] = value;
  }
  return tags;
}
