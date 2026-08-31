export interface LocalToolAsk {
  readonly id: string;
  readonly action: string;
  readonly target: string;
  readonly resourcePath?: string;
  readonly askedAtMs: number;
  readonly origin?: string;
  /** Present once answered; such a question is the daemon's to collect, not ours to re-ask. */
  readonly decision?: "allow" | "deny";
}

export interface AskPromptWindow {
  loadURL(url: string): Promise<void>;
  once(event: "closed", listener: () => void): void;
  isDestroyed(): boolean;
  destroy(): void;
  readonly webContents: { executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> };
}

export const LOCAL_TOOL_ASK_PROMPT_WINDOW = {
  width: 460,
  height: 300,
  resizable: false,
  minimizable: false,
  maximizable: false,
  alwaysOnTop: true,
  title: "Run on this computer?",
  webPreferences: { nodeIntegration: false, contextIsolation: true },
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character
  ));
}

/** Plain words for what is being asked for, in the terms a person thinks in. */
export function describeLocalToolAsk(ask: LocalToolAsk): string {
  if (ask.action === "run-command") return `run ${ask.target}`;
  if (ask.action === "read-file") return `read ${ask.target}`;
  if (ask.action === "write-file") return `change ${ask.target}`;
  return `${ask.action} ${ask.target}`;
}

/**
 * The question, phrased so the answer is an informed one.
 *
 * It names the exact thing being asked for and where the request came from,
 * because "a bot wants to do something" is not something anybody can sensibly
 * agree to. Deny is the default: closing the window, pressing Escape, or
 * walking away all mean no, and only pressing Allow means yes.
 */
export function renderLocalToolAskPrompt(ask: LocalToolAsk): string {
  const what = escapeHtml(describeLocalToolAsk(ask));
  const from = ask.origin === undefined ? "" : `<p class="from">Asked by a bot on ${escapeHtml(ask.origin)}</p>`;
  return `<!doctype html><meta charset="utf-8"><title>Run on this computer?</title>
<style>
  :root { color-scheme: light dark; font: 13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; }
  body { margin: 0; padding: 20px 22px; display: flex; flex-direction: column; gap: 12px; }
  h1 { margin: 0; font-size: 15px; }
  .what { margin: 0; padding: 10px 12px; border-radius: 8px; background: rgba(127,127,127,.14);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-all; }
  .from { margin: 0; opacity: .68; font-size: 12px; }
  .note { margin: 0; opacity: .68; font-size: 12px; }
  .row { margin-top: auto; display: flex; gap: 8px; justify-content: flex-end; }
  button { font: inherit; padding: 6px 14px; border-radius: 7px; border: 1px solid rgba(127,127,127,.4);
           background: transparent; color: inherit; }
  button.primary { border-color: transparent; background: #2f6feb; color: #fff; }
</style>
<h1>Let a bot ${what} on this computer?</h1>
<p class="what">${what}</p>
${from}
<p class="note">Nothing runs unless you allow it. If you do nothing, this is refused.</p>
<div class="row">
  <button id="deny">Don${"’"}t allow</button>
  <button id="allow" class="primary">Allow</button>
</div>
<script>
  const answer = new Promise((resolve) => {
    document.getElementById("allow").addEventListener("click", () => resolve({ decision: "allow" }));
    document.getElementById("deny").addEventListener("click", () => resolve({ decision: "deny" }));
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") resolve({ decision: "deny" }); });
  });
  window.__sandLocalToolAnswer = answer;
</script>`;
}

export interface LocalToolAskWatcherDependencies {
  readonly readPendingAsks: () => Promise<readonly LocalToolAsk[]>;
  readonly recordApproval: (approval: { id: string; action: string; target: string; resourcePath?: string }) => Promise<void>;
  readonly answerAsk: (id: string, decision: "allow" | "deny") => Promise<boolean>;
  readonly createWindow: (options: typeof LOCAL_TOOL_ASK_PROMPT_WINDOW) => AskPromptWindow;
  readonly reportFailure?: (error: unknown) => void;
}

/**
 * Ask a person about one waiting request at a time.
 *
 * One at a time is deliberate. A machine reached from elsewhere can produce
 * several requests at once, and a stack of near-identical dialogs is how
 * someone ends up clicking Allow on something they did not read.
 *
 * The approval is recorded before the answer is, because the approval is what
 * the daemon actually consults: doing it the other way round would briefly
 * report a yes that grants nothing.
 */
export function createLocalToolAskWatcher(dependencies: LocalToolAskWatcherDependencies): {
  poll(): Promise<void>;
  isPrompting(): boolean;
} {
  let prompting = false;
  return {
    isPrompting: () => prompting,
    async poll() {
      if (prompting) return;
      let waiting: readonly LocalToolAsk[];
      try { waiting = await dependencies.readPendingAsks(); }
      catch (error) { dependencies.reportFailure?.(error); return; }
      // A question that already has its answer is waiting on the daemon to
      // collect it, and showing it again would ask a person twice.
      const ask = waiting.find((entry) => entry.id.length > 0 && entry.decision === undefined);
      if (ask === undefined) return;
      prompting = true;
      let window: AskPromptWindow | undefined;
      try {
        window = dependencies.createWindow(LOCAL_TOOL_ASK_PROMPT_WINDOW);
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderLocalToolAskPrompt(ask))}`);
        const dismissed = new Promise<{ decision: "deny" }>((resolve) => {
          window!.once("closed", () => resolve({ decision: "deny" }));
        });
        const answered = window.webContents.executeJavaScript("window.__sandLocalToolAnswer", true) as Promise<{ decision: "allow" | "deny" }>;
        const answer = await Promise.race([answered, dismissed]);
        if (answer.decision === "allow") {
          await dependencies.recordApproval({
            id: ask.id, action: ask.action, target: ask.target,
            ...(ask.resourcePath === undefined ? {} : { resourcePath: ask.resourcePath }),
          });
        }
        await dependencies.answerAsk(ask.id, answer.decision);
      } catch (error) {
        dependencies.reportFailure?.(error);
        // An answer that could not be collected is not a yes.
        await dependencies.answerAsk(ask.id, "deny").catch(() => undefined);
      } finally {
        if (window !== undefined && !window.isDestroyed()) window.destroy();
        prompting = false;
      }
    },
  };
}
