const MANAGED_CANVAS_REGEX = /(?:^|\/)\.cursor\/projects\/[^/]+\/canvases\/[^/]+\.canvas\.tsx$/i;
export function normalizeCanvasPath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop(); else segments.push(segment);
  }
  return segments.join("/");
}
export const isManagedCanvasPath = (value: string): boolean => MANAGED_CANVAS_REGEX.test(normalizeCanvasPath(value));
