import { installCollectionsPreloadEntrypoint, loadCollectionsPreloadElectron } from "../preload-collections.js";

installCollectionsPreloadEntrypoint(loadCollectionsPreloadElectron(require("electron")));
