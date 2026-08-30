import { installWebviewPreloadEntrypoint, loadBrowserPreloadElectron } from "../preload-webview.js";

installWebviewPreloadEntrypoint(loadBrowserPreloadElectron(require("electron")));
