import type { SelectedUIElement } from "../proto/generated/agent/v1/selected_context_pb.js";

export interface SelectedUIElementsTextContent {
  readonly type: "text";
  readonly text: string;
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed selected-UI-elements prompt leaf. DOM capture and the parent
// processSelectedContext function remain absent.
export function renderSelectedUIElementsContext(
  uiElements: readonly SelectedUIElement[],
): SelectedUIElementsTextContent | undefined {
  if (uiElements.length === 0) {
    return undefined;
  }
  const uiElementsText = uiElements.map(uiElement => {
    if (uiElement.component !== undefined && uiElement.component !== "") {
      let parsedProps: unknown;
      if (uiElement.componentPropsJson !== undefined && uiElement.componentPropsJson !== "") {
        try {
          parsedProps = JSON.parse(uiElement.componentPropsJson);
        } catch (_error) {
          parsedProps = { error: "Invalid JSON" };
        }
      }
      return `<ui_element>
React Component: ${uiElement.component}
Props: ${parsedProps ? JSON.stringify(parsedProps, null, 2) : "None"}
xpath: ${uiElement.xpath}
</ui_element>`;
    }
    return `<ui_element>
${uiElement.element}
xpath: ${uiElement.xpath}
textContent: ${uiElement.textContent}
</ui_element>`;
  }).join("\n\n");
  return {
    type: "text",
    text: `<selected_ui_elements>
The following UI elements have been selected by the user from the runtime.
${uiElementsText}
</selected_ui_elements>`,
  };
}
