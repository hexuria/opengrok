import type { LsDirectoryTreeNode } from "../proto/generated/agent/v1/ls_exec_pb.js";
import { renderDirectoryTreeWithinBudget } from "./tools/core/ls/formatters.js";

export interface SelectedFolderForPrompt {
  readonly path: string;
  readonly directoryTree?: LsDirectoryTreeNode | undefined;
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed attached-folders prompt leaf. The parent processSelectedContext
// function remains absent.
export function renderAttachedFoldersContext(
  folders: readonly SelectedFolderForPrompt[],
): string | undefined {
  if (folders.length === 0) {
    return undefined;
  }
  const folderContents: string[] = [];
  for (const folder of folders) {
    if (!folder.directoryTree) {
      continue;
    }
    const formattedTree = renderDirectoryTreeWithinBudget(folder.directoryTree);
    const folderPath = folder.path;
    folderContents.push(`Folder: ${folderPath}
Contents of directory:
${formattedTree.result}`);
  }
  if (folderContents.length === 0) {
    return undefined;
  }
  return `<attached_folders>
Here are some folder${folders.length > 1 ? "s" : ""} I manually attached to my message:

${folderContents.join("\n\n")}
</attached_folders>`;
}
