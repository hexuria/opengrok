import path from "node:path";

import { AGENT_STORE_AUTOMATION_MOUNT_NAME } from "../../../constants/agent-store-ids.js";
import { MountedAgentStoreKind, type MountedAgentStore } from "../../../proto/generated/agent/v1/request_context_exec_pb.js";

export function automationToolNameToSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

const AUTOMATION_MEMORY_DIRECTORY_NAME = "memories";
const AUTOMATION_MEMORY_DEFAULT_FILE = "MEMORIES.md";
const AUTOMATION_MEMORY_INSTRUCTION_MARKER = "__CURSOR_AUTOMATION_MEMORY_INSTRUCTIONS__";
const AUTOMATION_MEMORY_UNAVAILABLE_INSTRUCTION = "Automation memory is unavailable for this run. Do not attempt to read or write memory; continue with the available context and tools.";

function getMountedPathModule(mountPath: string): typeof path.posix | typeof path.win32 {
  return path.win32.isAbsolute(mountPath) && !path.posix.isAbsolute(mountPath) ? path.win32 : path.posix;
}

function resolveAutomationMemoryDirectory(stores: readonly MountedAgentStore[]): string | undefined {
  const automationStore = stores.find((store) => store.kind === MountedAgentStoreKind.PRINCIPAL && store.alias === AGENT_STORE_AUTOMATION_MOUNT_NAME);
  const mountPath = automationStore?.path?.trim();
  if (mountPath === undefined || mountPath.length === 0) return undefined;
  return getMountedPathModule(mountPath).join(mountPath, AUTOMATION_MEMORY_DIRECTORY_NAME);
}

function buildAutomationMemoryInstruction(memoryDirectory: string): string {
  const pathModule = getMountedPathModule(memoryDirectory);
  const defaultFile = pathModule.join(memoryDirectory, AUTOMATION_MEMORY_DEFAULT_FILE);
  const directoryPrefix = `${memoryDirectory}${pathModule.sep}`;
  return [
    `Your durable memories live in the directory ${memoryDirectory}; use your normal file tools on it.`,
    `At the start of a run, inspect ${directoryPrefix} for prior context. Read ${defaultFile} if it exists, along with any relevant topic files.`,
    "When you learn something that should persist across runs, update those files with ordinary file edits.",
    "Prefer short, factual notes. Re-read a file before rewriting it if another run may have changed it.",
    `Prefer per-topic files under ${directoryPrefix} over one ever-growing note when topics diverge.`,
    "Do not invent a memory tool — write the files directly.",
  ].join(" ");
}

export function materializeAutomationMemoryInstruction(
  automationInstructions: string,
  stores: readonly MountedAgentStore[],
): string {
  if (!automationInstructions.includes(AUTOMATION_MEMORY_INSTRUCTION_MARKER)) return automationInstructions;
  const memoryDirectory = resolveAutomationMemoryDirectory(stores);
  const replacement = memoryDirectory !== undefined
    ? buildAutomationMemoryInstruction(memoryDirectory)
    : AUTOMATION_MEMORY_UNAVAILABLE_INSTRUCTION;
  return automationInstructions.split(AUTOMATION_MEMORY_INSTRUCTION_MARKER).join(replacement);
}
