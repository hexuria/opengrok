interface DetailedLine {
  readonly lineNumber?: number;
  readonly text: string;
}

interface CodeBlockFormattingOptions {
  readonly enableLineNumbers?: boolean;
  readonly gpt5CodexCatN?: boolean;
  readonly gpt5StyleLineNumbers?: boolean;
  readonly sparseLineNumbers?: number;
}

interface CodeBlock {
  readonly content: string;
  readonly detailedLines?: readonly DetailedLine[];
  readonly extraAttributes?: Readonly<Record<string, unknown>>;
  readonly filePath?: string;
  readonly formattingOptions: CodeBlockFormattingOptions;
  readonly isFullFile?: boolean;
  readonly languageIdentifier?: string;
  readonly startLineNumber: number;
  readonly tag?: string;
  readonly totalLineNumbersInFile?: number;
}

interface FormatCodeBlockOptions {
  readonly addAmountOfOmittedLines?: boolean;
}

export function formatCodeBlock(codeBlock: CodeBlock, options: FormatCodeBlockOptions): string {
  let result: string;
  if (codeBlock.formattingOptions.enableLineNumbers === false) {
    if (codeBlock.detailedLines !== undefined) {
      result = codeBlock.detailedLines.map(line => line.text).join("\n");
    } else {
      result = codeBlock.content;
    }
  } else {
    result = addLineNumbers(
      codeBlock.formattingOptions,
      codeBlock.detailedLines ?? codeBlock.content,
      codeBlock.startLineNumber,
    );
  }
  if (options.addAmountOfOmittedLines === true && codeBlock.totalLineNumbersInFile !== undefined) {
    if (codeBlock.startLineNumber > 1) {
      const numHiddenLines = codeBlock.startLineNumber - 1;
      result = `... ${numHiddenLines} ${numHiddenLines === 1 ? "line" : "lines"} not shown ...\n${result}`;
    }
    const numLinesInCodeBlock = codeBlock.content.split("\n").length;
    const endLineNumber = codeBlock.startLineNumber + numLinesInCodeBlock - 1;
    if (codeBlock.totalLineNumbersInFile > endLineNumber) {
      const numHiddenLines = codeBlock.totalLineNumbersInFile - endLineNumber;
      result = `${result}\n... ${numHiddenLines} ${numHiddenLines === 1 ? "line" : "lines"} not shown ...`;
    }
  }
  if (codeBlock.tag !== undefined) {
    let isFullFileSection = "";
    if (codeBlock.isFullFile === true) {
      isFullFileSection = ' isFullFile="true"';
    }
    let languageIdentifierSection = "";
    if (codeBlock.languageIdentifier !== undefined) {
      languageIdentifierSection = ` language="${codeBlock.languageIdentifier}"`;
    }
    let pathSection = "";
    if (codeBlock.filePath) {
      pathSection = ` path="${codeBlock.filePath}"`;
    }
    let extraAttributesSection = "";
    if (codeBlock.extraAttributes !== undefined) {
      extraAttributesSection = Object.entries(codeBlock.extraAttributes)
        .map(([key, value]) => ` ${key}="${value}"`)
        .join("");
    }
    if (result.trim() === "") {
      result = `<${codeBlock.tag}${pathSection}${isFullFileSection}${languageIdentifierSection}${extraAttributesSection}></${codeBlock.tag}>`;
    } else {
      result = `\n<${codeBlock.tag}${pathSection}${isFullFileSection}${languageIdentifierSection}${extraAttributesSection}>\n${result}\n</${codeBlock.tag}>\n`;
    }
  }
  return result;
}

function addLineNumbers(
  formattingOptions: CodeBlockFormattingOptions,
  code: string | readonly DetailedLine[],
  startLineNumber: number,
): string {
  if (formattingOptions.gpt5CodexCatN === true) {
    return addLineNumbersGpt5CodexCatN(code, startLineNumber);
  } else if (formattingOptions.gpt5StyleLineNumbers === true) {
    return addLineNumbersGpt5(code, startLineNumber);
  } else {
    return addLineNumbersDefault(code, startLineNumber, formattingOptions.sparseLineNumbers);
  }
}

function addLineNumbersGpt5CodexCatN(
  code: string | readonly DetailedLine[],
  startLineNumber: number,
): string {
  if (typeof code === "string") {
    const lines = code.split("\n");
    return lines.map((line, index) => {
      const lineNumber = startLineNumber + index;
      const paddedLineNumber = lineNumber.toString().padStart(6, " ");
      return `${paddedLineNumber}  ${line}`;
    }).join("\n");
  } else {
    return code.map(line => {
      if (Number.isInteger(line.lineNumber)) {
        const paddedLineNumber = line.lineNumber!.toString().padStart(6, " ");
        return `${paddedLineNumber}  ${line.text}`;
      } else {
        return "...".padStart(6, " ");
      }
    }).join("\n");
  }
}

function addLineNumbersDefault(
  code: string | readonly DetailedLine[],
  startLineNumber: number,
  sparseN?: number,
): string {
  if (typeof code === "string") {
    const lines = code.split("\n");
    return lines.map((line, index) => {
      const lineNumber = startLineNumber + index;
      if (sparseN !== undefined && lineNumber % sparseN !== 0) {
        return line;
      }
      const paddedLineNumber = lineNumber.toString().padStart(6, " ");
      return `${paddedLineNumber}|${line}`;
    }).join("\n");
  } else {
    return code.map(line => {
      if (Number.isInteger(line.lineNumber)) {
        if (sparseN !== undefined && line.lineNumber! % sparseN !== 0) {
          return line.text;
        }
        const paddedLineNumber = line.lineNumber!.toString().padStart(6, " ");
        return `${paddedLineNumber}|${line.text}`;
      } else {
        return "...".padStart(6, " ");
      }
    }).join("\n");
  }
}

function addLineNumbersGpt5(
  code: string | readonly DetailedLine[],
  startLineNumber: number,
): string {
  if (typeof code === "string") {
    const lines = code.split("\n");
    return lines.map((line, index) => {
      const lineNumber = startLineNumber + index;
      return `L${lineNumber}:${line}`;
    }).join("\n");
  } else {
    return code.map(line => {
      if (Number.isInteger(line.lineNumber)) {
        return `L${line.lineNumber}:${line.text}`;
      } else {
        return "...";
      }
    }).join("\n");
  }
}
