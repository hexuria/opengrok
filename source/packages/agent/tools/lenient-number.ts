import { z } from "zod";

export function preprocessLenientNumber(value: unknown): unknown {
  if (value === undefined || typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return value;
    const number = Number(trimmed);
    return Number.isNaN(number) ? value : number;
  }
  return value;
}
export function lenientNumber<T extends z.ZodTypeAny = z.ZodNumber>(schema: T = z.number() as unknown as T) {
  return z.preprocess(preprocessLenientNumber, schema);
}
