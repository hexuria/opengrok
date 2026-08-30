export interface SelectedCursorCommandForPrompt {
  readonly name: string;
  readonly content: string;
}

export interface CursorCommandsTextContent {
  readonly type: "text";
  readonly text: string;
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed cursor-command prompt leaf. The parent processSelectedContext
// function remains absent.
export function renderSelectedCursorCommands(
  cursorCommands: readonly SelectedCursorCommandForPrompt[],
): CursorCommandsTextContent | undefined {
  if (cursorCommands.length === 0) {
    return undefined;
  }
  const commandsText = cursorCommands.map((command) => `

--- Cursor Command: ${command.name} ---
${command.content}
--- End Command ---`).join("\n");
  if (!commandsText) {
    return undefined;
  }
  return {
    type: "text",
    text: `<cursor_commands>${commandsText}
</cursor_commands>`,
  };
}
