import { formatCodeBlock } from "./tools/core/formatting.js";
import type { Context } from "../context/core.js";
import type { AttachmentPathRequestContext } from "./context-processing-path-trust.js";
import {
  writeCodeSelectionToFile,
  type CodeSelectionResourceAccessor,
} from "./context-processing-code-selection.js";

interface CodeSelectionRange {
  readonly start?: { readonly line?: number | undefined } | undefined;
  readonly end?: { readonly line?: number | undefined } | undefined;
}

export interface SelectedCodeSelectionForPrompt {
  readonly path: string;
  readonly content: string;
  readonly range?: CodeSelectionRange | undefined;
}

export interface CodeSelectionFormattingOptions {
  readonly enableLineNumbers?: boolean;
  readonly gpt5CodexCatN?: boolean;
  readonly gpt5StyleLineNumbers?: boolean;
  readonly sparseLineNumbers?: number;
}

export interface CodeSelectionTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface RenderSelectedCodeSelectionsArgs {
  readonly ctx: Context;
  readonly codeSelections: readonly SelectedCodeSelectionForPrompt[];
  readonly formattingOptions: CodeSelectionFormattingOptions;
  readonly enableLongCodeSelectionSpillToFile: boolean;
  readonly requestContext: AttachmentPathRequestContext | undefined;
  readonly resourceAccessor: CodeSelectionResourceAccessor | undefined;
}

export interface RenderedCodeSelections {
  readonly attachedFilesContent: CodeSelectionTextContent[];
  readonly documentInfos: Array<{ readonly path: string }>;
}

const CODE_SELECTION_INLINE_LIMIT = 2e4;

// Extracted from ../packages/agent/dist/context-processing.js as the
// dependency-closed code-selection branch. The parent processSelectedContext
// function remains absent.
export async function renderSelectedCodeSelections({
  ctx,
  codeSelections,
  formattingOptions,
  enableLongCodeSelectionSpillToFile,
  requestContext,
  resourceAccessor,
}: RenderSelectedCodeSelectionsArgs): Promise<RenderedCodeSelections> {
  const attachedFilesContent: CodeSelectionTextContent[] = [];
  const documentInfos: Array<{ readonly path: string }> = [];
  for (let index = 0; index < codeSelections.length; index += 1) {
    const codeSelection = codeSelections[index]!;
    const startLine = codeSelection.range?.start?.line ?? 1;
    const endLine = codeSelection.range?.end?.line ?? startLine;
    const isJupyterNotebook = codeSelection.path.endsWith(".ipynb");
    if (enableLongCodeSelectionSpillToFile && codeSelection.content.length > CODE_SELECTION_INLINE_LIMIT) {
      const spilled = await writeCodeSelectionToFile({
        ctx,
        content: codeSelection.content,
        originalPath: codeSelection.path,
        startLine,
        endLine,
        index,
        requestContext,
        resourceAccessor,
      });
      if (spilled !== undefined) {
        documentInfos.push(spilled);
        attachedFilesContent.push({
          type: "text",
          text: `<code_selection lines="${startLine}-${endLine}" source="${codeSelection.path}" file="${spilled.path}">
	The selection from \`${codeSelection.path}\` (lines ${startLine}-${endLine}) was too large to inline. Its full contents have been saved to \`${spilled.path}\`; read that file when you need the selection.
</code_selection>`,
        });
        continue;
      }
    }
    const formattedContent = formatCodeBlock({
      content: codeSelection.content,
      filePath: codeSelection.path,
      startLineNumber: startLine,
      totalLineNumbersInFile: undefined,
      formattingOptions: {
        ...formattingOptions,
        enableLineNumbers: formattingOptions.enableLineNumbers !== false && !isJupyterNotebook,
      },
      tag: "code_selection",
      extraAttributes: {
        lines: `${startLine}-${endLine}`,
      },
    } as unknown as Parameters<typeof formatCodeBlock>[0], {
      addAmountOfOmittedLines: false,
    });
    attachedFilesContent.push({
      type: "text",
      text: formattedContent,
    });
  }
  return { attachedFilesContent, documentInfos };
}
