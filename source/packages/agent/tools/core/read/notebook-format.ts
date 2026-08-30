import {
  extractCellSource,
  tryParseNotebook,
  type NotebookCellOutput,
} from "../notebook-utils.js";

const MAX_OUTPUT_CHARS_PER_CELL = 2_000;

function extractTextFromData(data: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["text/plain", "text/markdown"] as const) {
    const value = data[key];
    if (value) {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string").join("");
      }
    }
  }
  return undefined;
}

function extractOutputText(output: NotebookCellOutput): string | undefined {
  if (output.output_type === "error" && output.traceback) {
    const ESC = String.fromCharCode(27);
    const ansiPattern = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    return output.traceback.map(line => line.replace(ansiPattern, "")).join("\n");
  }
  if (
    (output.output_type === "execute_result" || output.output_type === "display_data") &&
    output.data !== undefined
  ) {
    return extractTextFromData(output.data);
  }
  if (typeof output.text === "string") return output.text;
  if (Array.isArray(output.text)) {
    const stringElements = output.text.filter((item): item is string => typeof item === "string");
    return stringElements.length > 0 ? stringElements.join("") : undefined;
  }
  return undefined;
}

export function formatNotebookForLLM(rawContent: string): string {
  const notebook = tryParseNotebook(rawContent);
  if (!notebook) return rawContent;

  const formattedCells: string[] = [];
  notebook.cells.forEach((cell, index) => {
    const source = extractCellSource(cell);
    const cellHeader = `\nCell ${index}:`;
    const cellContent = `\`\`\`\n${source}\`\`\``;
    const cellParts = [`${cellHeader}\n${cellContent}`];
    if (cell.outputs && cell.outputs.length > 0) {
      let outputText = "";
      for (const output of cell.outputs) {
        if (outputText.length >= MAX_OUTPUT_CHARS_PER_CELL) break;
        const extractedText = extractOutputText(output);
        if (extractedText) {
          if (outputText.length > 0 && !outputText.endsWith("\n")) outputText += "\n";
          outputText += extractedText;
        }
      }
      if (outputText.length > 0) {
        const isTruncated = outputText.length > MAX_OUTPUT_CHARS_PER_CELL;
        outputText = outputText.substring(0, MAX_OUTPUT_CHARS_PER_CELL);
        const outputHeader = `Cell ${index} output${isTruncated ? ` (truncated at ${MAX_OUTPUT_CHARS_PER_CELL} chars)` : ""}:`;
        const outputContent = `\`\`\`\n${outputText}\`\`\``;
        cellParts.push(`${outputHeader}\n${outputContent}`);
      }
    }
    formattedCells.push(cellParts.join("\n\n"));
  });
  if (formattedCells.length === 0) return "Notebook is empty (0 cells)";
  return `${formattedCells.join("\n\n")}\n\n`;
}
