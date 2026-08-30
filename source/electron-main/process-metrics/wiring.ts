export async function resolveScanRoots(
  mainPid: number,
  readDaemonDiscovery: () => Promise<{ readonly pid?: unknown } | null | undefined>,
  isProcessAlive: (pid: number) => boolean,
): Promise<number[]> {
  const roots = [mainPid];
  let daemonPid: unknown;
  try {
    daemonPid = (await readDaemonDiscovery())?.pid;
  } catch {
    return roots;
  }
  if (typeof daemonPid === "number" && daemonPid > 0 && daemonPid !== mainPid && isProcessAlive(daemonPid)) {
    roots.push(daemonPid);
  }
  return roots;
}
