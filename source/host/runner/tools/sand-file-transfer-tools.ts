import { posix } from "node:path";
import { z } from "zod";
import {
  BoxTransferError,
  resolveBoxWorkspacePath,
  SAND_BOX_UPLOADS_DIR,
  transferFileBetweenBoxes,
  type TransferBox,
} from "../../box/box-transfer.js";
import { SAND_BOX_NOT_READY_MESSAGE } from "../../ports/box.js";
import { fileBasename } from "../../sand-activity.js";
import { defineCommunicateTool } from "./communicate-tool.js";

export interface UserComputerHandle {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
  readonly box: TransferBox;
}

export interface FileTransferController {
  readonly agentBox: TransferBox;
  readonly userComputers: {
    resolve(computerId?: string): UserComputerHandle | undefined;
    list(): readonly UserComputerHandle[];
  };
  getComputerAgentId(): string;
  getBoxId(): string;
  isBoxPreparing(): boolean;
}

export const copyToBoxParameters = z.object({
  computer_path: z.string().trim().min(1).describe(
    "Absolute path of the file to pull, on the user's computer (the same filesystem your ExternalShell tool sees). Any file type and any size; copied verbatim, so binaries and large files are fine — unlike reading then re-writing it as text.",
  ),
  box_path: z.string().trim().min(1).optional().describe(
    "Where to put it inside your box. Absolute (e.g. /workspace/data.csv) or relative to /workspace. Omit to land it in /workspace/uploads under its original filename.",
  ),
  computer: z.string().trim().min(1).optional().describe(
    "Which connected computer to pull from. Omit for your default (the single computer connected today).",
  ),
});

export const copyFromBoxParameters = z.object({
  box_path: z.string().trim().min(1).describe(
    "Path of the file in your box to push out. Absolute (e.g. /workspace/report.pdf) or relative to /workspace. Any file type and any size; copied verbatim. Expand any glob in Shell first and pass a concrete path.",
  ),
  computer_path: z.string().trim().min(1).optional().describe(
    "Destination path on the user's computer (the ExternalShell side). Absolute, or relative to the ExternalShell working directory. Omit to land it under its original filename in that directory.",
  ),
  computer: z.string().trim().min(1).optional().describe(
    "Which connected computer to push to. Omit for your default (the single computer connected today).",
  ),
});

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${units[unitIndex]}`;
}

export function resolveComputerOrThrow(
  controller: FileTransferController,
  computerId?: string,
): UserComputerHandle {
  const handle = controller.userComputers.resolve(computerId);
  if (handle != null) return handle;
  const known = controller.userComputers.list();
  const list = known.length > 0
    ? known.map((computer) => `${computer.id}${computer.connected ? "" : " (offline)"}`).join(", ")
    : "none connected";
  if (computerId == null) {
    throw new BoxTransferError(
      `No computer is connected right now (the Grok Bot desktop app must be open and online to transfer files). Connected computers: ${list}.`,
    );
  }
  throw new BoxTransferError(
    `Unknown computer "${computerId}". Connected computers: ${list}.`,
  );
}

export function assertBoxReady(controller: FileTransferController): void {
  if (controller.isBoxPreparing()) throw new BoxTransferError(SAND_BOX_NOT_READY_MESSAGE);
}

export async function copyFileToBox(
  context: unknown,
  args: z.infer<typeof copyToBoxParameters>,
  controller: FileTransferController,
): Promise<string> {
  assertBoxReady(controller);
  const computer = resolveComputerOrThrow(controller, args.computer);
  const boxPath = resolveBoxWorkspacePath(
    args.box_path
      ?? posix.join(SAND_BOX_UPLOADS_DIR, posix.basename(args.computer_path)),
  );
  const bytes = await transferFileBetweenBoxes(context, {
    source: {
      box: computer.box,
      agentId: controller.getComputerAgentId(),
      path: args.computer_path,
      label: computer.label,
    },
    dest: {
      box: controller.agentBox,
      agentId: controller.getBoxId(),
      path: boxPath,
      label: "your box",
    },
  });
  return `Copied ${args.computer_path} from ${computer.label} into your box at ${boxPath} (${formatBytes(bytes)}). Open it with Shell.`;
}

export async function copyFileFromBox(
  context: unknown,
  args: z.infer<typeof copyFromBoxParameters>,
  controller: FileTransferController,
): Promise<string> {
  assertBoxReady(controller);
  const computer = resolveComputerOrThrow(controller, args.computer);
  const boxPath = resolveBoxWorkspacePath(args.box_path);
  const computerPath = args.computer_path ?? posix.basename(boxPath);
  const bytes = await transferFileBetweenBoxes(context, {
    source: {
      box: controller.agentBox,
      agentId: controller.getBoxId(),
      path: boxPath,
      label: "your box",
    },
    dest: {
      box: computer.box,
      agentId: controller.getComputerAgentId(),
      path: computerPath,
      label: computer.label,
    },
  });
  return `Copied ${boxPath} from your box to ${computer.label} at ${computerPath} (${formatBytes(bytes)}). The user can open it there with ExternalShell.`;
}

export function createFileTransferTools(controller: FileTransferController) {
  return [
    defineCommunicateTool(controller, {
      id: "COPY_TO_BOX",
      name: "CopyToBox",
      description: "Copy a file from the user's computer into your box, verbatim. Use this to bring a user's file (any type or size — a CSV, PDF, archive, image, dataset, binary) onto your box so you can work on it with Shell or Read, or open it in the box browser (parent agents delegate that GUI interaction to computerUse). This is the deliberate way to get a file into the box: the user does not have to drag it into chat first, and unlike reading the file and re-writing it, the bytes are copied exactly (no truncation, binaries are safe). Give the file's absolute path on the user's computer (the path your ExternalShell tool would use); it lands in /workspace/uploads by default, or at a box_path you choose. Then open it with Shell at the path reported back.",
      parameters: copyToBoxParameters,
      describeActivity: (args: z.infer<typeof copyToBoxParameters>) => {
        const detail = fileBasename(args.computer_path);
        return detail == null ? {} : { detail };
      },
      execute: (context, args: z.infer<typeof copyToBoxParameters>, dependencies) =>
        copyFileToBox(context, args, dependencies),
    }),
    defineCommunicateTool(controller, {
      id: "COPY_FROM_BOX",
      name: "CopyFromBox",
      description: "Copy a file from your box out to the user's computer, verbatim. Use this to hand the user a file you generated or downloaded in the box (a spreadsheet, report, log, archive, anything) by placing it on their actual computer where their ExternalShell, editor, and apps can reach it. Any type or size; the bytes are copied exactly (no truncation, binaries are safe). This is for putting a file ON their disk; to instead show a file inline in chat (an image, a video, or a downloadable attachment) use SendMessage with the box path. Give the box_path of the file; it lands under its own name in the ExternalShell working directory by default, or at a computer_path you choose.",
      parameters: copyFromBoxParameters,
      describeActivity: (args: z.infer<typeof copyFromBoxParameters>) => {
        const detail = fileBasename(args.box_path);
        return detail == null ? {} : { detail };
      },
      execute: (context, args: z.infer<typeof copyFromBoxParameters>, dependencies) =>
        copyFileFromBox(context, args, dependencies),
    }),
  ];
}
