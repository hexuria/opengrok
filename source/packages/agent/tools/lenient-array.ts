import { z } from "zod";

import { jsonTokens, leakedParameter, namesAKeyTwice } from "./mcp/dynamic-tool-argument-repair.js";

const parseWholeArray = (text: string): unknown[] | undefined => {
  if (namesAKeyTwice(text)) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const diagnose = (text: string): string => {
  if (namesAKeyTwice(text)) return "duplicate-key";
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? "unreachable" : `parsed-as-${typeof parsed}`;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "";
    if (/Unexpected end of (JSON input|data)/.test(message)) return "truncated";
    try {
      const requoted: unknown = JSON.parse(text.replace(/'/g, '"'));
      if (Array.isArray(requoted)) return "python-repr";
    } catch {
      // Preserve the artifact's diagnostic fall-through.
    }
    return "corrupt-json";
  }
};

const decodeLeadingJsonArray = (blob: string): { readonly value: unknown[]; readonly rest: string } | undefined => {
  const start = blob.indexOf("[");
  if (start < 0) return undefined;
  let depth = 0;
  for (const token of jsonTokens(blob, start)) {
    if (token.kind !== "punctuation") continue;
    if (token.char === "[" || token.char === "{") {
      depth++;
    } else if ((token.char === "]" || token.char === "}") && --depth === 0) {
      const value = parseWholeArray(blob.slice(start, token.index + 1));
      return value === undefined ? undefined : { value, rest: blob.slice(token.index + 1) };
    }
  }
  return undefined;
};

const looksMultiItem = (scalar: string): boolean => /,\s*\S/.test(scalar) || /\n\s*\S/.test(scalar);

type RepairResult =
  | { readonly ok: true; readonly value: unknown[]; readonly strategy: string }
  | { readonly ok: false; readonly reason: string };

const repairStringifiedArray = (value: string, field: string, itemsArePrimitive: boolean): RepairResult => {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  const direct = parseWholeArray(trimmed);
  if (direct !== undefined) return { ok: true, value: direct, strategy: "clean-json" };

  const leaks = [...trimmed.matchAll(leakedParameter)];
  if (leaks.length > 0) {
    const names = leaks.map(match => match[1]);
    const mine = leaks.filter(match => match[1] === field);
    if (mine.length === 1 && names.every(name => name === field)) {
      const inner = parseWholeArray((mine[0]?.[2] ?? "").trim());
      if (inner !== undefined) return { ok: true, value: inner, strategy: "strip-leaked-markup" };
    }
    return { ok: false, reason: `leaked-markup-unrecoverable(${[...new Set(names)].join("|")})` };
  }
  if (itemsArePrimitive && !/^[[{]/.test(trimmed)) {
    if (looksMultiItem(trimmed)) return { ok: false, reason: "scalar-looks-multi-item" };
    if (parseWholeArray(`[${trimmed}]`) === undefined) return { ok: true, value: [value], strategy: "wrap-scalar" };
  }
  if (trimmed.startsWith("[")) {
    const leading = decodeLeadingJsonArray(trimmed);
    if (leading !== undefined && /^[\s,\]}]*$/.test(leading.rest)) {
      return { ok: true, value: leading.value, strategy: "drop-contentless-tail" };
    }
  }
  return { ok: false, reason: diagnose(trimmed) };
};

function preprocessLenientArray(value: unknown, options: { readonly field: string; readonly primitiveItems?: boolean }): unknown {
  if (typeof value !== "string") return value;
  const repair = repairStringifiedArray(value, options.field, options.primitiveItems === true);
  return repair.ok ? repair.value : value;
}

export function lenientArray<T extends z.ZodTypeAny>(schema: T, options: { readonly field: string; readonly primitiveItems?: boolean }): z.ZodEffects<T, z.output<T>, unknown> {
  return z.preprocess(value => preprocessLenientArray(value, options), schema);
}
