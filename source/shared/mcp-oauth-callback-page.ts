function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderCallbackPage(args: { title: string; message: string; hint: string }): string {
  const { title, message, hint } = args;
  return [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">', `<title>${escapeHtml(title)}</title>`,
    "<style>", "html,body{margin:0;min-height:100%;}",
    'body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0c0c0d;color:#f4f4f5;}',
    ".page{display:flex;min-height:100vh;flex:1;align-items:center;justify-content:center;}", ".content{text-align:center;}",
    ".message{font-size:1.125rem;line-height:1.75rem;margin:0;font-weight:400;}", ".hint{margin:0.5rem 0 0;font-size:1rem;line-height:1.5rem;color:#a1a1aa;}",
    "</style>", "</head>", "<body>", '<main class="page">', '<div class="content">',
    `<p class="message">${escapeHtml(message)}</p>`, `<p class="hint">${escapeHtml(hint)}</p>`,
    "</div>", "</main>", "</body>", "</html>"
  ].join("");
}

export function renderMcpOAuthSuccessPage(args?: { serverName?: string }): string {
  const serverName = args?.serverName?.trim();
  const hasName = serverName != null && serverName.length > 0;
  return renderCallbackPage({ title: hasName ? `${serverName} connected` : "Authentication complete", message: "Authorization complete!", hint: "You can close this tab." });
}

export function renderMcpOAuthErrorPage(args?: { serverName?: string }): string {
  const serverName = args?.serverName?.trim();
  const hasName = serverName != null && serverName.length > 0;
  return renderCallbackPage({ title: hasName ? `${serverName} — Authentication failed` : "Authentication failed", message: "OAuth callback failed.", hint: "Close this tab and try connecting again." });
}
