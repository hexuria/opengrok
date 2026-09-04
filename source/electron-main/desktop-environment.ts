export function configureDesktopEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  readonly isAttachProdBox: boolean;
  readonly isLabBuild: boolean;
  readonly appVersion?: string;
}): void {
  if (input.isAttachProdBox) input.env.SAND_ATTACH_PROD_BOX = "1";
  else if (!input.isPackaged) input.env.SAND_ATTACH_PROD_BOX = "0";
  input.env.SAND_PACKAGED = input.isAttachProdBox || input.isPackaged ? "1" : "0";
  input.env.SAND_LAB = input.isLabBuild ? "1" : "0";
  if (input.appVersion != null) input.env.SAND_CLIENT_APP_VERSION = input.appVersion;
  input.env.SAND_DISABLE_UPDATES ??= "1";
  input.env.SAND_DISABLE_SENTRY ??= "1";
  input.env.SAND_DISABLE_TELEMETRY ??= "1";
}
