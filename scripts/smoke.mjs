import { outputApp } from "./lib/config.mjs";
import { runNativeE2E } from "./native-e2e-check.mjs";

const report = await runNativeE2E({
  appPath: outputApp,
  payloadPath: outputApp,
  structuralOnly: false,
  timeoutMs: 12_000,
});

for (const item of report.diagnostics) {
  console.log(`${item.status.toUpperCase().padEnd(4)} ${item.check}: ${item.detail}`);
}
console.log(`Smoke verification: ${report.status.toUpperCase()}`);
process.exitCode = report.status === "pass" ? 0 : report.status === "prerequisite" ? 2 : 1;
