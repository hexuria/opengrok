export function isValidIanaTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function formatUtcOffset(now: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    }).formatToParts(now);
    const raw = parts.find((part) => part.type === "timeZoneName")?.value;
    if (raw == null) return null;
    const offset = raw.replace(/^GMT/, "");
    return `UTC${offset.length > 0 ? offset : "+0"}`;
  } catch {
    return null;
  }
}

export function renderTimeZoneSystemPrompt(
  timeZone: string | null | undefined,
  now = new Date(),
): string {
  if (timeZone == null || timeZone.length === 0) return "";
  const offset = formatUtcOffset(now, timeZone);
  const zone = offset != null ? `${timeZone} (currently ${offset})` : timeZone;
  return [
    "## Time",
    `Your box and tools run on a UTC clock, but the user lives in ${zone}. So any time you report to them — a git or gh timestamp, a file's mtime, a log line, "finished at", a schedule — is a UTC value: convert it to the user's zone and label it clearly (a short tag like "PT" is enough) rather than parroting the raw UTC time back.`,
  ].join("\n");
}
