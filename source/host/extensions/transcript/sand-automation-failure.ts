export function isBackgroundAutomationTrigger(trigger: string): boolean {
  return trigger === "schedule" || trigger === "event";
}
export function normalizeAutomationErrorKind(
  detail: string | null | undefined,
): string {
  const text = (detail ?? "").trim().toLowerCase();
  if (text.length === 0) return "unknown";
  const normalized = text
    .replace(/\([^)]*\)/g, " ")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      " ",
    )
    .replace(/0x[0-9a-f]+/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    normalized.split(" ").filter(Boolean).slice(0, 6).join(" ") || "unknown"
  );
}
export function shouldNotifyAutomationFailure(occurrence: number): boolean {
  return occurrence <= 1 || (occurrence & (occurrence - 1)) === 0;
}
