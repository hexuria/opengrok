export function brandedEnumOf<const Values extends readonly string[], const Fallback extends string>(
  values: Values,
  fallback: Fallback,
): (value: string | undefined) => Values[number] | Fallback | undefined {
  const admitted = new Set<string>(values);
  return (value) => {
    if (value === undefined) return undefined;
    return admitted.has(value) ? (value as Values[number]) : fallback;
  };
}

export function brandLiteralEnum<const Value extends string>(value: Value): Value {
  return value;
}

const OPAQUE_ID = /^[0-9A-Za-z._:|-]{1,128}$/;

export function brandedId(value: string | undefined): string | undefined {
  return value !== undefined && OPAQUE_ID.test(value) ? value : undefined;
}

export const SAND_ERRNO_TAGS = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EADDRINUSE",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOSPC",
  "EDQUOT",
  "EROFS",
  "EBUSY",
  "EMFILE",
  "EIO",
] as const;

export const SAND_ERRNO_FALLBACK = "E_OTHER" as const;
export const brandedErrno = brandedEnumOf(SAND_ERRNO_TAGS, SAND_ERRNO_FALLBACK);
