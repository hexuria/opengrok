export interface ExternalLinkContent {
  readonly url: string;
  readonly title: string;
  readonly content: string;
}

// Extracted from the external-links prompt branch of
// ../packages/agent/dist/context-processing.js as an uncomposed leaf.
// Web scraping and the parent processSelectedContext function remain absent.
export function renderExternalLinksContext(links: readonly ExternalLinkContent[]): string | undefined {
  if (links.length === 0) {
    return undefined;
  }
  let linksText = `<external_links>
### Potentially Relevant Websearch Results

You should respond as if these information are known to you. Refrain from saying "I am unable to browse the internet" or "I don't have access to the internet" or "I'm unable to provide real-time news updates". This is your internet search results. Please always cite any links you referenced from the above search results in markdown format.

-------
`;
  for (const link of links) {
    linksText += `Website URL: ${link.url}
Website Title: ${link.title}
Website Content:
${link.content}
____

`;
  }
  linksText += `</external_links>`;
  return linksText;
}
