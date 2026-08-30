import { z } from "zod";
import { defineCommunicateTool } from "./communicate-tool.js";
import { invariant } from "../../../shared/invariant.js";
import type { Context } from "../../../packages/context/core.js";

export const requestBoxHelpParameters = z.object({
  instruction: z.string().trim().min(1).describe(
    'A short instruction shown over the box and in chat, addressed to the user (e.g. "Sign in to your Google account", "Approve the 2FA prompt"). Keep it to one line; no explanatory paragraph.',
  ),
  reason: z.enum(["auth", "captcha", "payment", "other"])
    .optional()
    .catch(undefined)
    .describe(
      'Why the user is needed: "auth" for any sign-in step (login, SSO, passkey, 2FA), "captcha", "payment", or "other".',
    ),
  domain: z.string().trim().optional().catch(undefined).describe(
    'Destination app/site the user is trying to access (e.g. "salesforce.com", "google.com"). On a normal login page this is the browser-bar host. On an SSO/IdP page (Okta, Google accounts, Azure AD, …) this is the *destination* app that started SSO — NOT the IdP host (put that in idp_domain). Omit when unknown or the step is not on a website.',
  ),
  idp_domain: z.string().trim().optional().catch(undefined).describe(
    'When the browser is on an SSO/IdP page, the IdP host from the URL bar (e.g. "anysphere.okta.com", "accounts.google.com", "login.microsoftonline.com"). Omit on a direct app login with no separate IdP.',
  ),
});

export type BoxHelpReason = "auth" | "captcha" | "payment" | "other";

export type BoxHelpOutcome =
  | { readonly kind: "already-pending"; readonly requestId: string; readonly instruction: string }
  | { readonly kind: "started"; readonly requestId: string };

export interface BoxHelpDependencies<_Context = Context> {
  getAgentId(): string | undefined;
  endTurn(): void;
  requestHelp(request: {
    readonly agentId: string;
    readonly instruction: string;
    readonly telemetry: {
      readonly reason?: BoxHelpReason;
      readonly domain?: string;
      readonly idpDomain?: string;
    };
  }): Promise<BoxHelpOutcome>;
  onSendMessage(
    message: { readonly type: "text"; readonly content: string },
    timestampMs: number,
    metadata: { readonly requestId: string; readonly instruction: string },
  ): void;
  now?: () => number;
}

export function normalizeBoxHelpDomain(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return undefined;
  try {
    const hostname = new URL(value.includes("://") ? value : `https://${value}`).hostname;
    const host = hostname.replace(/^www\./, "");
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

export function connectorCardEmissionToMessage(emission: {
  readonly connector: string;
  readonly serverId: string;
  readonly variant: string;
}) {
  return {
    type: "connector" as const,
    connector: emission.connector,
    serverId: emission.serverId,
    variant: emission.variant,
  };
}

export function createRequestBoxHelpTool(deps: BoxHelpDependencies) {
  return defineCommunicateTool(deps, {
    id: "REQUEST_BOX_HELP",
    name: "request_box_help",
    description: `Hand your box's desktop to the user for a step only they can do: a login, SSO, passkey, 2FA, captcha, or payment confirmation. Pass one short instruction (no paragraph); the box is surfaced with a "hand back to agent" button and that instruction is shown in chat, then your turn ends. The user does the step on the box and hands it back, and you are resumed automatically, so start by using the read-only Screenshot tool to see what they changed. Use this instead of asking for credentials: the user signs in themselves on the box and you never see their password or 2FA. For classification: domain is the destination app being accessed; when the browser has redirected to an SSO/IdP page (Okta, Google accounts, \u2026), still put the destination app in domain and put the IdP host in idp_domain.`,
    parameters: requestBoxHelpParameters,
    async execute(
      _context: Context,
      args: z.infer<typeof requestBoxHelpParameters>,
      resolved,
    ) {
      const agentId = resolved.getAgentId();
      invariant(agentId != null, "request_box_help was called outside an agent run.");
      resolved.endTurn();
      const domain = args.domain == null ? undefined : normalizeBoxHelpDomain(args.domain);
      const idpDomain = args.idp_domain == null
        ? undefined
        : normalizeBoxHelpDomain(args.idp_domain);
      const outcome = await resolved.requestHelp({
        agentId,
        instruction: args.instruction,
        telemetry: {
          ...(args.reason == null ? {} : { reason: args.reason }),
          ...(domain == null ? {} : { domain }),
          ...(idpDomain == null ? {} : { idpDomain }),
        },
      });
      if (outcome.kind === "already-pending") {
        return `The user still has the box: you handed it to them for "${outcome.instruction}" and they haven't handed it back, so this request was NOT sent \u2014 asking twice would put a second copy of the same request in their chat. Do not ask again. If you have something to tell them (what you're waiting on, or that you need a different step), say it with SendMessage; otherwise just wait, and you'll be resumed automatically when they hand the box back.`;
      }
      resolved.onSendMessage(
        { type: "text", content: args.instruction },
        (resolved.now ?? Date.now)(),
        {
          requestId: outcome.requestId,
          instruction: args.instruction,
        },
      );
      return "Handed the box to the user. They have control now; wait for them to hand it back, and you'll be resumed automatically.";
    },
  });
}
