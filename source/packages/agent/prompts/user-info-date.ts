function buildFriendlyDate(date: Date, timeZone?: string): string | undefined {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "short",
      day: "2-digit",
      year: "numeric",
    });
    const parts = formatter.formatToParts(date);
    const partLookup: Record<string, string> = {};
    for (const part of parts) {
      if (part.type === "literal") continue;
      partLookup[part.type] = part.value;
    }
    const weekday = partLookup.weekday;
    const month = partLookup.month;
    const day = partLookup.day;
    const year = partLookup.year;
    if (weekday && month && day && year) {
      const normalizedDay = Number.parseInt(day, 10).toString();
      return `${weekday} ${month} ${normalizedDay}, ${year}`;
    }
  } catch {
    // Fall through to the local timezone, then the ISO date.
  }
  return undefined;
}

export function getFriendlyDateForTimeZone(timeZone?: string): string {
  const now = new Date();
  const formatted = buildFriendlyDate(now, timeZone);
  if (formatted) return formatted;
  const fallbackFormatted = buildFriendlyDate(now, undefined);
  if (fallbackFormatted) return fallbackFormatted;
  return now.toISOString().split("T")[0]!;
}
