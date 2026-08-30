export type SandMessageLengthBucket = "empty" | "xs" | "s" | "m" | "l" | "xl";
export function sandMessageLengthBucket(length: number): SandMessageLengthBucket { if (length <= 0) return "empty"; if (length < 20) return "xs"; if (length < 100) return "s"; if (length < 500) return "m"; if (length < 2_000) return "l"; return "xl"; }
