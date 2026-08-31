import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A GUI app on Windows opens a visible console window for every
// console-subsystem child unless windowsHide is set — Node's default is
// false. These are the process-spawning chokepoints and the high-frequency
// background probes; each must keep the console hidden so routine work never
// flashes windows at the user. Terminals we *mean* to show (Terminal.app,
// `cmd /c start`, Linux terminal emulators) open their own new window, which
// windowsHide on the intermediate child does not suppress.
test("background process spawns keep the Windows console hidden", async () => {
  const expectations = [
    // Chokepoints: everything routed through these is covered at once.
    ["source/packages/utils/spawn-promise.ts", [/windowsHide \?\?= true/]],
    ["source/packages/shell-exec/sandbox/unsafe-spawn.ts", [/windowsHide: true/]],
    ["source/packages/shell-exec/sandbox/helper-support.ts", [/windowsHide: true/, /windowsHide: true[\s\S]*windowsHide: true[\s\S]*windowsHide: true/]],
    // Polled Windows-specific probes — the worst offenders if unhidden.
    ["source/packages/agent-store-sync/store-lock.ts", [/execFileSync\("whoami"[\s\S]{0,80}windowsHide: true/]],
    ["source/packages/cursor-config/auth/mdm-sign-in-policy.ts", [/execFileAsync\("reg\.exe"[^)]*windowsHide: true/]],
    ["source/electron-main/local-exec/local-exec-native.ts", [/powershell\.exe[\s\S]{0,400}windowsHide: true/]],
    // Recurring background helpers.
    ["source/electron-main/box/local-docker-host-connector.ts", [/windowsHide: true/]],
    ["source/packages/git-core/git-exec.ts", [/windowsHide: true/]],
    ["source/node-agent-coordinator/webauthn/signer.ts", [/windowsHide: true/]],
    ["source/shared/node/subscription-cli-auth.ts", [/windowsHide: true/]],
  ];
  for (const [file, patterns] of expectations) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    for (const pattern of patterns) {
      assert.match(source, pattern, `${file} must hide the Windows console (${pattern})`);
    }
  }
});
