import { installDevControlsPreloadEntrypoint, loadDevControlsPreloadElectron } from "../preload-dev-controls.js";

installDevControlsPreloadEntrypoint(loadDevControlsPreloadElectron(require("electron")));
