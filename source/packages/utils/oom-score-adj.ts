import { writeFileSync } from "node:fs";
export function resetChildOomScoreAdj(pid: number | undefined): void {
  if (process.platform !== "linux" || pid === undefined || pid <= 0) return;
  try { writeFileSync(`/proc/${pid}/oom_score_adj`, "0"); } catch {}
}
