import { installVncPreloadEntrypoint, loadVncPreloadElectron } from "../preload-vnc.js";

installVncPreloadEntrypoint(loadVncPreloadElectron(require("electron")));
