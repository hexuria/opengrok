export const isAbsolutePath = (filePath: string): boolean => filePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\");
const splitPath = (value: string): string[] => value.split(/[/\\]/).filter(Boolean);

function matchProjectSubdir(value: string, targetDir: string): { workspaceId: string; remainingPath: string[] } | null {
  const parts = splitPath(value);
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (parts[index] === ".cursor" && parts[index + 1] === "projects" && parts[index + 3] === targetDir) {
      return { workspaceId: parts[index + 2]!, remainingPath: parts.slice(index + 4) };
    }
  }
  return null;
}

export const isAgentTranscriptPath = (value: string): boolean => matchProjectSubdir(value, "agent-transcripts") !== null;
export const isCursorTerminalsDirectory = (value: string): boolean => {
  const match = matchProjectSubdir(value, "terminals");
  return match !== null && match.remainingPath.length === 0;
};
export const isAgentToolOutputFile = (filePath: string): boolean => {
  const match = matchProjectSubdir(filePath, "agent-tools");
  return match !== null && match.remainingPath.length === 1 && match.remainingPath[0]?.endsWith(".txt") === true;
};
export function extractTerminalId(filePath: string): { id: number } | null {
  const match = matchProjectSubdir(filePath, "terminals");
  if (match === null || match.remainingPath.length !== 1) return null;
  const fileMatch = /^(\d+)\.txt$/.exec(match.remainingPath[0]!);
  if (fileMatch?.[1] === undefined) return null;
  const id = Number.parseInt(fileMatch[1], 10);
  return Number.isNaN(id) ? null : { id };
}
export const isTerminalFilePath = (filePath: string): boolean => extractTerminalId(filePath) !== null;
export const sanitizeFilename = (name: string): string => name.replace(/[^a-zA-Z0-9._-]/g, "_");
