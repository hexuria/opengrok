export async function getFirstItem<T>(iterable: AsyncIterable<T>): Promise<{ firstItem: T; rest: AsyncIterable<T> } | undefined> {
  const iterator = iterable[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return undefined;
  const rest: AsyncIterable<T> = { async *[Symbol.asyncIterator]() { while (true) { const next = await iterator.next(); if (next.done) return; yield next.value; } } };
  return { firstItem: first.value, rest };
}
