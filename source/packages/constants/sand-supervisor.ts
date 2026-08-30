export const SAND_SUPERVISOR_DIR = "/tmp/sand-supervisor";
export const SAND_SUPERVISOR_COMMAND_PATH = `${SAND_SUPERVISOR_DIR}/command.json`;
export const SAND_SUPERVISOR_COMMAND_PART_PATH = `${SAND_SUPERVISOR_COMMAND_PATH}.part`;
export const SAND_SUPERVISOR_STATUS_PATH = `${SAND_SUPERVISOR_DIR}/status.json`;
export const SAND_SUPERVISOR_ACKS_DIR = `${SAND_SUPERVISOR_DIR}/acks`;
export const SAND_SUPERVISOR_STAGED_BUNDLE_PATH = `${SAND_SUPERVISOR_DIR}/incoming-host-bundle.tgz`;
export const SAND_SUPERVISOR_STAGED_BUNDLE_PART_PATH = `${SAND_SUPERVISOR_STAGED_BUNDLE_PATH}.part`;
export const SAND_SUPERVISOR_DESKTOP_HEALTH_PATH = `${SAND_SUPERVISOR_DIR}/desktop-health.json`;
export const SAND_BOX_AGENT_DATA_ROOT = "/home/box/sand-data";
export const SAND_BOX_HOST_UPGRADE_MARKER_PATH = `${SAND_BOX_AGENT_DATA_ROOT}/.sand-host-upgrade.json`;
export const SAND_BOX_HOST_DIR = "/home/box/sand-host";
export const SAND_BOX_HOST_ENTRY = `${SAND_BOX_HOST_DIR}/host-main.cjs`;
export const SAND_BOX_HOST_VERSION_PATH = `${SAND_BOX_HOST_DIR}/version`;
export const SAND_HOST_UPGRADE_MAX_DEFER_MS = 6 * 60 * 60 * 1_000;

export type SandSupervisorCommand = {
  id: string;
  kind: string;
  issuedAtMs: number;
  reason?: string;
  mode?: string;
  version?: string;
  bundlePath?: string;
  forceNow?: true;
};

export type BuildSandSupervisorCommandArgs = Omit<SandSupervisorCommand, "issuedAtMs"> & { nowMs: number };

export function buildSandSupervisorCommand(args: BuildSandSupervisorCommandArgs): SandSupervisorCommand {
  const command: SandSupervisorCommand = { id: args.id, kind: args.kind, issuedAtMs: args.nowMs };
  if (args.reason !== undefined) command.reason = args.reason;
  if (args.kind === "upgrade") {
    if (args.mode !== undefined) command.mode = args.mode;
    if (args.version !== undefined) command.version = args.version;
    if (args.bundlePath !== undefined) command.bundlePath = args.bundlePath;
    if (args.forceNow === true) command.forceNow = true;
  }
  return command;
}

export const serializeSandSupervisorCommand = (command: SandSupervisorCommand): string => JSON.stringify(command);
export const isSandHostUpgradeAvailable = (current: string, target: string | null | undefined): boolean => target != null && target.length > 0 && current !== target;
