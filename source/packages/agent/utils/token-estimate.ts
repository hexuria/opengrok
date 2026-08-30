export function estimateStringTokenCount(value: string): number {
  return Math.round(value.length / 4);
}
