import { buildReconstructedAsar } from "./clean-build.mjs";

const result = await buildReconstructedAsar();
console.log(`Reconstructed ASAR: ${result.builtAsar}`);
console.log("Renderer mode: Vite clean-source frontend");
