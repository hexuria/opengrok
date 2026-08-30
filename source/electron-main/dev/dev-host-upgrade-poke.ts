import { createDeadlinePolicy, realClock } from "../../internal/scheduling.js";
import { GATEWAY_API_PREFIX } from "../../shared/gateway-wire.js";

export const POKE_TIMEOUT_MS = 30_000;
export interface DevCommandOutcome { readonly isOk: boolean; readonly exitCode: number | null; readonly output: string; readonly durationMs: number }

export function formatHostUpgradePokeOutcome(result: Record<string, unknown>): Pick<DevCommandOutcome, "isOk" | "output"> {
  const version = typeof result.version === "string" ? result.version : "";
  const reason = typeof result.reason === "string" ? result.reason : "";
  if (result.started === true) {
    return {
      isOk: true,
      output: [
        "outcome: staged (real updateHostNow — fetch + stage OK)",
        version.length > 0 ? `to_version: ${version}` : undefined,
        "The supervisor hot-swaps the bundle at its next idle tick (forced) and emits sand.host.upgrade @phase:swap. Watch Box logs for the swap outcome.",
      ].filter((line): line is string => line != null).join("\n"),
    };
  }
  if (reason === "already-latest") {
    return { isOk: true, output: `outcome: no-op — host already on latest${version.length > 0 ? ` (${version})` : ""}. Nothing to fetch/stage.` };
  }
  return { isOk: false, output: ["outcome: not started", `reason: ${reason.length > 0 ? reason : "(no reason returned)"}`].join("\n") };
}

export async function pokeHostUpgrade(deps: {
  readonly gatewayBaseUrl: string;
  readonly token: string | null;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): Promise<DevCommandOutcome> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsedMs = (): number => now() - startedAt;
  if (deps.token == null || deps.token.length === 0) {
    return { isOk: false, exitCode: null, output: "No gateway token found (is the box up?).", durationMs: elapsedMs() };
  }
  const deadline = createDeadlinePolicy(realClock, { name: "dev-host-upgrade-poke", timeoutMs: deps.timeoutMs ?? POKE_TIMEOUT_MS });
  try {
    return await deadline.run(async (signal) => {
      const response = await fetchFn(`${deps.gatewayBaseUrl}${GATEWAY_API_PREFIX}/updateHostNow`, {
        method: "POST",
        headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ force: true, includeErrorDetail: true }),
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return { isOk: false, exitCode: response.status, output: `updateHostNow HTTP ${response.status}${detail.length > 0 ? `\n${detail}` : ""}`, durationMs: elapsedMs() };
      }
      const body = await response.json() as Record<string, unknown>;
      const outcome = formatHostUpgradePokeOutcome(body);
      return { ...outcome, exitCode: outcome.isOk ? 0 : 1, durationMs: elapsedMs() };
    });
  } catch (error) {
    return { isOk: false, exitCode: null, output: `updateHostNow request failed: ${String(error)}`, durationMs: elapsedMs() };
  }
}
