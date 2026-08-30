import path from "node:path";

export function resolvePackagedAppArtifacts(appPath) {
  if (typeof appPath !== "string" || appPath.trim() === "") {
    throw new TypeError("A packaged application path is required");
  }
  const resolvedApp = path.resolve(appPath);
  if (path.extname(resolvedApp) !== ".app") {
    throw new TypeError(`Expected a .app bundle path, received ${appPath}`);
  }
  const asarPath = path.join(resolvedApp, "Contents", "Resources", "app.asar");
  return Object.freeze({
    appPath: resolvedApp,
    asarPath,
    unpackedPath: `${asarPath}.unpacked`,
  });
}
