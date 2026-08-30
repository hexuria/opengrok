export const ROSTER_REPLICA_KEY = "roster";

export function transcriptReplicaKey(agentId: string): string {
  return `transcript:${agentId}`;
}

export const ORDERED_REPLICAS_V1 = "orderedReplicasV1";
