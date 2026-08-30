export const DEV_CONTROLS_RPC_CONTRACT_NAME = "dev-controls";
export const DEV_CONTROLS_METHOD_TABLE = {
  restartElectron: { args: "none" },
  reloadWindow: { args: "none" },
  restartOnboarding: { args: "none" },
  skipOnboarding: { args: "none" },
  themeStatus: { args: "none" },
  setThemePreference: { args: "object" },
  boxStatus: { args: "none" },
  boxHealth: { args: "none" },
  upgradeHost: { args: "none" },
  pokeHostUpgrade: { args: "none" },
  rebuildBox: { args: "none" },
  tailLogs: { args: "none" },
  startBox: { args: "none" },
  teardownBox: { args: "none" },
  nukeBox: { args: "none" },
  openDesktop: { args: "none" },
  boxStoreStatus: { args: "none" },
  boxStoreSnapshotNow: { args: "none" },
  boxStoreLogs: { args: "none" },
  boxStoreRecreateFresh: { args: "none" },
  boxStoreClear: { args: "none" },
  attachProdBoxStatus: { args: "none" },
  setAttachProdBoxEnabled: { args: "object" },
  setWidgetGallery: { args: "object" },
  gatewayOfflineStatus: { args: "none" },
  setGatewayOffline: { args: "object" },
  onePasswordCliStatus: { args: "none" },
  prepareOnePasswordCli: { args: "none" },
  cancelOnePasswordCliPrepare: { args: "none" },
  onePasswordAccounts: { args: "none" },
  onePasswordVaults: { args: "none" },
  onePasswordFindVault: { args: "none" },
  onePasswordSyntheticProvisioning: { args: "none" },
} as const;

export type DevControlsMethod = keyof typeof DEV_CONTROLS_METHOD_TABLE;
export function isDevControlsMethod(value: string): value is DevControlsMethod {
  return Object.hasOwn(DEV_CONTROLS_METHOD_TABLE, value);
}
