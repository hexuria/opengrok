import { formatCodeBlock } from "./tools/core/formatting.js";

interface TerminalFormattingOptions {
  readonly enableLineNumbers?: boolean;
  readonly gpt5CodexCatN?: boolean;
  readonly gpt5StyleLineNumbers?: boolean;
  readonly sparseLineNumbers?: number;
}

export interface SelectedTerminalForPrompt {
  readonly title?: string | undefined;
  readonly path?: string | undefined;
  readonly content: string;
}

export interface SelectedTerminalRange {
  readonly start?: { readonly line?: number | undefined } | undefined;
  readonly end?: { readonly line?: number | undefined } | undefined;
}

export interface SelectedTerminalSelectionForPrompt {
  readonly title?: string | undefined;
  readonly path?: string | undefined;
  readonly content: string;
  readonly range?: SelectedTerminalRange | undefined;
}

export interface AttachedTerminalTextPart {
  readonly type: "text";
  readonly text: string;
}

const SHELL_CHAR_HARD_LIMIT = 2e4;

function truncateOutput(output: string, maxLength: number, frontAndBack: boolean): { output: string; truncated: boolean } {
  if (output.length <= maxLength) return { output, truncated: false };
  if (frontAndBack) {
    const halfLength = Math.floor(maxLength / 2);
    return {
      output: output.substring(0, halfLength) + "\n\n... (output truncated) ...\n\n" + output.substring(output.length - halfLength),
      truncated: true,
    };
  }
  return { output: output.substring(0, maxLength) + "\n\n... (output truncated)", truncated: true };
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed terminal-context rendering leaf. The parent processSelectedContext
// function remains absent.
export function renderSelectedTerminalContext(
  terminals: readonly SelectedTerminalForPrompt[],
  terminalSelections: readonly SelectedTerminalSelectionForPrompt[],
  formattingOptions: TerminalFormattingOptions,
): AttachedTerminalTextPart[] {
  const attachedFilesContent: AttachedTerminalTextPart[] = [];
  for (const terminal of terminals) {
    const extraAttributes: Record<string, string> = {};
    if (terminal.title) {
      extraAttributes.title = terminal.title;
    }
    if (terminal.path) {
      extraAttributes.path = terminal.path;
    }
    const formattedContent = formatCodeBlock({
      content: terminal.content,
      filePath: "",
      startLineNumber: 1,
      formattingOptions: {
        ...formattingOptions,
        enableLineNumbers: false,
      },
      tag: "terminal_output",
      ...(Object.keys(extraAttributes).length > 0 ? { extraAttributes } : {}),
    }, {
      addAmountOfOmittedLines: false,
    });
    const truncatedContent = truncateOutput(formattedContent, SHELL_CHAR_HARD_LIMIT, true);
    attachedFilesContent.push({
      type: "text",
      text: truncatedContent.output,
    });
  }
  for (const terminalSelection of terminalSelections) {
    const startLine = terminalSelection.range?.start?.line ?? 1;
    const endLine = terminalSelection.range?.end?.line ?? startLine;
    const extraAttributes: Record<string, string> = {};
    if (terminalSelection.title) {
      extraAttributes.title = terminalSelection.title;
    }
    if (terminalSelection.path) {
      extraAttributes.path = terminalSelection.path;
    }
    extraAttributes.lines = `${startLine}-${endLine}`;
    const formattedContent = formatCodeBlock({
      content: terminalSelection.content,
      filePath: "",
      startLineNumber: startLine,
      formattingOptions: {
        ...formattingOptions,
        enableLineNumbers: false,
      },
      tag: "terminal_selection",
      extraAttributes,
    }, {
      addAmountOfOmittedLines: false,
    });
    attachedFilesContent.push({
      type: "text",
      text: formattedContent,
    });
  }
  return attachedFilesContent;
}
