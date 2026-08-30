import { createKey, type Context } from "../../context/core.js";
import { LRUCache } from "../../utils/lru-cache.js";

const invocationCounter = new LRUCache<string, number>({ max: 100_000 });
const INVOCATION_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateSmallUuid(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (byte) => INVOCATION_SUFFIX_ALPHABET.charAt(byte % INVOCATION_SUFFIX_ALPHABET.length),
  ).join("");
}

function getNextInvocationCount(requestId: string): number {
  const currentCount = invocationCounter.get(requestId) ?? 0;
  invocationCounter.set(requestId, currentCount + 1);
  return currentCount;
}

export function getInvocationIdFromRequestId(requestId: string): string {
  const currentCount = getNextInvocationCount(requestId);
  return `${requestId}-${currentCount}-${generateSmallUuid()}`;
}

const defaultGenerator = (): string => crypto.randomUUID();

export const invocationIdGeneratorKey = createKey<() => string>(
  Symbol("invocationIdGenerator"),
  defaultGenerator,
);

export function getInvocationId(ctx: Context): string {
  const generator = ctx.get(invocationIdGeneratorKey);
  return generator();
}
