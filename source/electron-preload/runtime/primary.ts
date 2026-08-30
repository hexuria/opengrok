import { installPrimaryPreloadEntrypoint, loadPrimaryPreloadElectron } from "../preload.js";

installPrimaryPreloadEntrypoint(loadPrimaryPreloadElectron(require("electron")));
