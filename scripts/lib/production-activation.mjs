import { canonicalizeRetainedElectronNativePackages } from "../build-electron-natives.mjs";
import { hostBindingProvenancePath } from "../host-production-activation.mjs";
import { electronMainBindingProvenancePath } from "../electron-main-production-activation.mjs";

export { hostBindingProvenancePath, electronMainBindingProvenancePath };

export function assertProductionActivationsAreClean(hostActivation, electronMainActivation) {
  if (!hostActivation?.clean) {
    throw new Error(`Host clean-source activation is required; refusing to ship a 0.18 artifact host.${hostActivation?.blocker ? ` ${hostActivation.blocker}` : ""}`);
  }
  if (!electronMainActivation?.clean) {
    throw new Error(`Electron-main clean-source activation is required; refusing to ship a 0.18 artifact main.${electronMainActivation?.blocker ? ` ${electronMainActivation.blocker}` : ""}`);
  }
}

export function compositionWithProductionActivations(hostActivation, electronMainActivation, composition) {
  if (!Array.isArray(composition)) throw new TypeError("compositionWithProductionActivations requires composition");
  assertProductionActivationsAreClean(hostActivation, electronMainActivation);
  return composition.map(runtime => {
    if (runtime.runtime === "host") return {
      runtime: "host", path: "dist/host/host-main.cjs", mode: "clean-source", source: "source/host/main.ts", bindingManifest: hostBindingProvenancePath,
    };
    if (runtime.runtime === "electron-main") return {
      runtime: "electron-main", path: "dist/electron-main/main.cjs", mode: "clean-source", source: "source/electron-main/main.ts", bindingManifest: electronMainBindingProvenancePath,
      runtimePackageFiles: electronMainActivation.runtimePackageFiles,
    };
    return runtime;
  });
}

export function fallbackSourcesReplacedByActivations(hostActivation, electronMainActivation, composition) {
  if (!Array.isArray(composition)) throw new TypeError("fallbackSourcesReplacedByActivations requires composition");
  const cleanRuntimes = new Set([
    ...(hostActivation.clean ? ["host"] : []),
    ...(electronMainActivation.clean ? ["electron-main"] : []),
  ]);
  return composition
    .filter(({ runtime, mode, sourceBundle }) => cleanRuntimes.has(runtime) && mode === "artifact-fallback" && typeof sourceBundle === "string")
    .map(({ sourceBundle }) => sourceBundle);
}

export function retainedNativePackagesFromActivations(hostActivation, electronMainActivation) {
  const recorded = [
    hostActivation?.provenance?.executableGraph?.retainedNativePackages,
    electronMainActivation?.provenance?.executableGraph?.retainedNativePackages,
  ];
  if (recorded.some(packages => !Array.isArray(packages))) {
    throw new Error("Clean activation did not record esbuild-metafile retained native packages");
  }
  return canonicalizeRetainedElectronNativePackages(recorded.flat());
}
