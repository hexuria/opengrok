import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SAND_WEBAUTHN_PROXY_MARKER_PATH = "/home/box/.sand-webauthn-proxy-enabled";
export const BOX_CHROME_POLICY_COMMAND = "/usr/local/bin/box-chrome-policy";

export function applyWebAuthnProxyMarker(
  enabled: boolean,
  markerPath = SAND_WEBAUTHN_PROXY_MARKER_PATH,
  policyCommand = BOX_CHROME_POLICY_COMMAND
): "not-a-box" | "unchanged" | "applied" {
  if (!existsSync(dirname(markerPath))) return "not-a-box";
  const present = existsSync(markerPath);
  if (present === enabled) return "unchanged";
  if (enabled) writeFileSync(markerPath, "", { encoding: "utf8", mode: 0o644 });
  else unlinkSync(markerPath);
  if (existsSync(policyCommand)) spawnSync(policyCommand, [], { stdio: "ignore" });
  return "applied";
}

