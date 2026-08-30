import { z } from "zod";

export function preprocessLenientBoolean(value: unknown): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}
export function lenientBoolean<T extends z.ZodTypeAny = z.ZodBoolean>(schema?: T) {
  return z.preprocess(preprocessLenientBoolean, schema ?? z.boolean());
}
