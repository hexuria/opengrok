export const PRE_ATTACH_BUFFER_LIMIT = 100;
export type TelemetryLevel = "info" | "warn" | "error";
export type TelemetryMetadata = Readonly<Record<string, string | undefined>>;
export const DESKTOP_LIFECYCLE_FAMILIES = [
  "reportDesktopStartup", "reportDesktopProcessCrash", "reportDesktopRendererLifecycle",
  "reportDesktopCoordinatorHandoff", "reportDesktopLocalExecLifecycle", "reportDesktopUncleanExit",
] as const;
export type DesktopLifecycleFamily = typeof DESKTOP_LIFECYCLE_FAMILIES[number];
export type DesktopLifecycleUploader = Record<DesktopLifecycleFamily, (level: TelemetryLevel, metadata: TelemetryMetadata) => void>;

export function createDesktopLifecycleReporter() {
  let attached: DesktopLifecycleUploader | undefined;
  const buffered: { family: DesktopLifecycleFamily; level: TelemetryLevel; metadata: TelemetryMetadata }[] = [];
  const forward = (family: DesktopLifecycleFamily) => (level: TelemetryLevel, metadata: TelemetryMetadata): void => {
    if (attached == null) {
      if (buffered.length >= PRE_ATTACH_BUFFER_LIMIT) buffered.shift();
      buffered.push({ family, level, metadata });
      return;
    }
    attached[family](level, metadata);
  };
  return {
    attach(uploader: DesktopLifecycleUploader): void {
      attached = uploader;
      for (const record of buffered.splice(0)) uploader[record.family](record.level, record.metadata);
    },
    reportDesktopStartup: forward("reportDesktopStartup"),
    reportDesktopProcessCrash: forward("reportDesktopProcessCrash"),
    reportDesktopRendererLifecycle: forward("reportDesktopRendererLifecycle"),
    reportDesktopCoordinatorHandoff: forward("reportDesktopCoordinatorHandoff"),
    reportDesktopLocalExecLifecycle: forward("reportDesktopLocalExecLifecycle"),
    reportDesktopUncleanExit: forward("reportDesktopUncleanExit"),
  };
}
