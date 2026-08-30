import { execFile, type ChildProcess } from "node:child_process";

type SandboxMetadata = {
  pid: number;
  startTime: Date;
  unrelatedPids?: Set<number>;
};

type SandboxRelationship = "related" | "probably_unrelated" | "maybe_related";

type SandboxDenyEvent =
  | { raw: string }
  | { timestamp: unknown; duplicateCount?: number; raw: string }
  | {
      timestamp: unknown;
      processName: string;
      pid: number;
      decision: string;
      decisionCode: number;
      operation: string;
      target: string;
      duplicateCount: number;
      raw: string;
      relationship: SandboxRelationship;
    };

const sandboxMetadataMap = new WeakMap<ChildProcess, SandboxMetadata>();

export function registerSandboxMetadata(child: ChildProcess, metadata: SandboxMetadata): void {
  sandboxMetadataMap.set(child, metadata);
}

export async function captureSandboxDenies(child: ChildProcess): Promise<SandboxDenyEvent[]> {
  const metadata = sandboxMetadataMap.get(child);
  if (!metadata) {
    console.log("No sandbox metadata found on child process");
    return [];
  }
  return captureSandboxDeniesInternal(metadata.pid, metadata.startTime, metadata.unrelatedPids);
}

function determineRelationship(eventPid: number, rootPid: number, unrelatedPids?: Set<number>): SandboxRelationship {
  if (eventPid === rootPid) {
    return "related";
  }
  if (unrelatedPids?.has(eventPid)) {
    return "probably_unrelated";
  }
  return "maybe_related";
}

function captureSandboxDeniesInternal(pid: number, startTime: Date, unrelatedPids?: Set<number>): Promise<SandboxDenyEvent[]> {
  return new Promise((resolve) => {
    try {
      const now = new Date();
      const secondsAgo = Math.ceil((now.getTime() - startTime.getTime()) / 1e3);
      const logArgs = [
        "show",
        "--style",
        "ndjson",
        "--predicate",
        `process=="kernel" AND eventMessage CONTAINS "Sandbox:" AND eventMessage contains "deny"`,
        "--last",
        secondsAgo.toString(),
      ];
      execFile("/usr/bin/log", logArgs, (error, stdout, _stderr) => {
        if (error) {
          resolve([{ raw: error.message }]);
          return;
        }
        const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
        const out: SandboxDenyEvent[] = [];
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            const msg = obj?.eventMessage ?? "";
            if (!msg || typeof msg !== "string") continue;
            const deny = /^Sandbox:\s+([^(]+)\((\d+)\)\s+([a-zA-Z-]+)\((\d+)\)\s+([^\s]+)\s+(.+)$/.exec(msg);
            if (deny) {
              const [, processName, pidStr, decision, decisionCodeStr, operation, targetRest] = deny;
              const eventPid = Number(pidStr);
              out.push({
                timestamp: obj.timestamp,
                processName: processName!.trim(),
                pid: eventPid,
                decision: decision!.toLowerCase(),
                decisionCode: Number(decisionCodeStr),
                operation,
                target: targetRest,
                duplicateCount: 1,
                raw: msg,
                relationship: determineRelationship(eventPid, pid, unrelatedPids),
              });
              continue;
            }
            const duplicate = /^(\d+) duplicate report for Sandbox: (.+)$/.exec(msg);
            if (duplicate) {
              const count = Number(duplicate[1]);
              const inner = duplicate[2]!;
              const duplicateMatch = /^([^(]+)\((\d+)\)\s+([a-zA-Z-]+)\((\d+)\)\s+([^\s]+)\s+(.+)$/.exec(inner);
              if (duplicateMatch) {
                const [, processName, pidStr, decision, decisionCodeStr, operation, targetRest] = duplicateMatch;
                const eventPid = Number(pidStr);
                out.push({
                  timestamp: obj.timestamp,
                  processName: processName!.trim(),
                  pid: eventPid,
                  decision: decision!.toLowerCase(),
                  decisionCode: Number(decisionCodeStr),
                  operation,
                  target: targetRest,
                  duplicateCount: count,
                  raw: msg,
                  relationship: determineRelationship(eventPid, pid, unrelatedPids),
                });
              } else {
                out.push({ timestamp: obj.timestamp, duplicateCount: count, raw: msg });
              }
              continue;
            }
            out.push({ timestamp: obj.timestamp, raw: msg });
          } catch {
          }
        }
        resolve(out);
      });
    } catch (error) {
      resolve([{ raw: String(error) }]);
    }
  });
}
