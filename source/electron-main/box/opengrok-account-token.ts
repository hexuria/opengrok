import { OPENGROK_ACCESS_TOKEN_SECRET } from "../../shared/box-runtime.js";
import { getAccessTokenExpiryMs } from "../../shared/node/cursor-token.js";

/*
 * The identity a gateway connection carries.
 *
 * An access token lives an hour. The connector used to attach whatever copy of
 * it the secret store held at connect time and then keep that connection for as
 * long as the stream stayed live — so once the copy expired, every call for the
 * rest of the session presented a dead token, and the server (until it learned
 * to refuse) answered those calls as its own configured account. Somebody
 * else's bots in the sidebar; writes into their transcripts. "Stored and
 * non-empty" was being read as "usable", and it is not.
 *
 * This asks the auth service for a token that is valid NOW — the same move the
 * account API calls already make — writes it back so every other reader sees
 * the same copy, and falls back to the stored one only when renewal is
 * unavailable, because being unable to renew is not the same as having no
 * identity. If renewal fails and the stored copy is dead, the server refuses it
 * by code and the connection is rebuilt once through here again; if that also
 * fails, the failure surfaces with the code intact, and the person is asked to
 * sign in rather than quietly becoming someone else.
 */
export interface OpenGrokAccountTokenDeps {
  readSecret(key: string): Promise<string | null>;
  writeSecret(key: string, value: string): Promise<void>;
  getValidAccessToken(options: { readonly backendUrl: string }): Promise<string>;
  /** Injectable clock, for tests. */
  now?(): number;
}

export async function readValidOpenGrokAccountToken(deps: OpenGrokAccountTokenDeps, backendUrl: string): Promise<string | null> {
  let stored = "";
  try { stored = (await deps.readSecret(OPENGROK_ACCESS_TOKEN_SECRET)) ?? ""; } catch { stored = ""; }
  let access = stored;
  try {
    const fresh = await deps.getValidAccessToken({ backendUrl });
    if (typeof fresh === "string" && fresh.length > 0) access = fresh;
  } catch {
    // Renewal unavailable (offline, no refresh token, service not up yet): the
    // stored copy is the best identity we have, and the server is the judge of it.
  }
  if (access !== stored && access.length > 0) {
    try { await deps.writeSecret(OPENGROK_ACCESS_TOKEN_SECRET, access); } catch { /* best-effort: the connection still carries the fresh one */ }
  }
  if (access.length === 0) return null;
  // A copy we can see has already expired is not an identity either. Handing it
  // over anyway only moves the refusal to the server and hides, behind a
  // generic failure, the one fact the person needs: this session cannot be
  // renewed and they have to sign in again.
  const expiresAtMs = getAccessTokenExpiryMs(access);
  if (expiresAtMs != null && expiresAtMs <= (deps.now ?? Date.now)()) return null;
  return access;
}
