export const SAND_SUBAGENT_ID_PREFIX = "sand-subagent-";

export function isSandSubagentId(id: string): boolean {
  return id.startsWith(SAND_SUBAGENT_ID_PREFIX);
}
