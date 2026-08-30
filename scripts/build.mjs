import { buildFidelityReconstructedAsar } from "./clean-build.mjs";

const result = await buildFidelityReconstructedAsar();
console.log(`Reconstructed ASAR: ${result.builtAsar}`);
console.log("Renderer mode: checksum-pinned upstream 0.18.0 payload");
