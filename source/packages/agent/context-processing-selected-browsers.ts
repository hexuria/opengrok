import type { SelectedBrowser } from "../proto/generated/agent/v1/selected_context_pb.js";

export interface SelectedBrowsersTextContent {
  readonly type: "text";
  readonly text: string;
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed selected-browser prompt leaf. Browser lookup and the parent
// processSelectedContext function remain absent.
export function renderSelectedBrowsersContext(
  selectedBrowsers: readonly SelectedBrowser[],
): SelectedBrowsersTextContent | undefined {
  if (selectedBrowsers.length === 0) {
    return undefined;
  }
  const browsersText = selectedBrowsers.map(browser => {
    const title = browser.pageTitle || "Untitled";
    return `- ${title}
  URL: ${browser.url}
  Browser ID: ${browser.browserId}`;
  }).join("\n");
  return {
    type: "text",
    text: `<browser_context>
The user has attached the following browser tab(s) as context. You can use the Browser ID to interact with these tabs using browser tools:
${browsersText}
</browser_context>`,
  };
}
