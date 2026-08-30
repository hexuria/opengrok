/**
 * Last-connect status for the user's own OpenGrok server, kept in its own tiny
 * module for the same reason account-computer-status.ts is: main-edge is loaded
 * in isolation by tests, so it must not reach the connector's dependency graph
 * just to read a status line.
 */
export interface OpenGrokServerStatus {
  readonly ok: boolean;
  readonly detail: string;
  readonly gatewayUrl: string | null;
}

let status: OpenGrokServerStatus = { ok: false, detail: "Not connected yet.", gatewayUrl: null };

export function getOpenGrokServerStatus(): OpenGrokServerStatus { return status; }
export function noteOpenGrokServerStatus(next: OpenGrokServerStatus): void { status = next; }
