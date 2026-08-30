import {
  createDeadlinePolicy,
  realClock,
  type DeadlinePolicy,
} from "../../../internal/scheduling.js";
import { responseToImageDataUrl } from "../http-image.js";
import { CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS } from "../marketplace/cursor-marketplace-client.js";
import { isKnownPluginLogoUrl } from "../marketplace/cursor-marketplace-logo-registry.js";

export const LOGO_MAX_BYTES = 512 * 1024,
  LOGO_FETCH_CONCURRENCY = 6;
const logoCache = new Map<string, string | null>();
let active = 0;
const pending: Array<() => void> = [];
const marketplaceFetchDeadline = createDeadlinePolicy(realClock, {
  name: "mcp-marketplace-logo-fetch",
  timeoutMs: CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS,
});
const defaultLogoDependencies = {
  isKnownPluginLogoUrl,
  fetch: (url: string, signal: AbortSignal) => fetch(url, { signal }),
  responseToImageDataUrl,
  timeoutMs: CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS,
  deadline: marketplaceFetchDeadline,
};
export async function withLogoFetchSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= LOGO_FETCH_CONCURRENCY)
    await new Promise<void>((resolve) => pending.push(resolve));
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    pending.shift()?.();
  }
}
export async function resolvePluginLogo(
  url: string,
  deps: {
    isKnownPluginLogoUrl(url: string): boolean;
    fetch(url: string, signal: AbortSignal): Promise<Response>;
    responseToImageDataUrl(
      response: Response,
      maxBytes: number,
    ): Promise<string | null>;
    timeoutMs: number;
    deadline?: DeadlinePolicy;
  } = defaultLogoDependencies,
): Promise<string | null> {
  if (logoCache.has(url)) return logoCache.get(url) ?? null;
  if (!deps.isKnownPluginLogoUrl(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    logoCache.set(url, null);
    return null;
  }
  if (parsed.protocol !== "https:") {
    logoCache.set(url, null);
    return null;
  }
  try {
    const deadline =
      deps.deadline ??
      createDeadlinePolicy(realClock, {
        name: "mcp-marketplace-logo-fetch",
        timeoutMs: deps.timeoutMs,
      });
    const data = await withLogoFetchSlot(async () => {
      return deadline.run(async (signal) =>
        deps.responseToImageDataUrl(
          await deps.fetch(parsed.toString(), signal),
          LOGO_MAX_BYTES,
        ),
      );
    });
    logoCache.set(url, data);
    return data;
  } catch {
    logoCache.set(url, null);
    return null;
  }
}
