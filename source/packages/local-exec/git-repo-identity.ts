export function toHostPath(rawUrl: string): string {
  let url = rawUrl.trim();
  if (url.startsWith("git@")) {
    url = `https://${url.slice("git@".length).replace(":", "/")}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^https?:\/\//i.test(url)) {
    url = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "https://");
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    return parsed.hostname + pathname;
  } catch {
    url = url.replace(/^https?:\/\//i, "");
    url = url.replace(/[?#].*$/, "");
    url = url.replace(/\/+$/, "");
    url = url.replace(/\.git$/i, "");
    url = url.replace(/\/+$/, "");
    return url;
  }
}
