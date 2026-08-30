export interface DevControlsSender { readonly isDevControlsPanel: boolean }
export interface DevControlsTrustPolicy {
  readonly kind: "require";
  test(sender: DevControlsSender): boolean;
  readonly denial: string;
}
export function createDevControlsTrust(): { readonly devControlsPanel: DevControlsTrustPolicy } {
  return {
    devControlsPanel: {
      kind: "require",
      test: (sender) => sender.isDevControlsPanel,
      denial: "The dev-controls edge is only accessible from the Dev Controls panel window.",
    },
  };
}

type MaybePromise<T = unknown> = T | Promise<T>;
export interface DevControlsHandlerDependencies {
  postControl(path: string): MaybePromise;
  fetchTheme(search: string): MaybePromise;
  fetchGatewayOffline(search: string): MaybePromise;
  onePasswordCli: {
    inspect(): MaybePromise; prepare(): MaybePromise; cancel(): void;
    listAccounts(): MaybePromise; listVaults(): MaybePromise; findDefaultVault(): MaybePromise;
    runSyntheticProvisioning(): MaybePromise;
  };
  getAttachProdBoxStatus(): unknown;
  writeAttachProdBoxPrefs(enabled: boolean): unknown;
  collectBoxStatus(): MaybePromise;
  collectBoxHealth(): MaybePromise;
  runDevBoxScript(command: string): MaybePromise;
  pokeHostUpgrade(): MaybePromise;
  tailBoxLogs(): MaybePromise;
  nukeBox(): MaybePromise;
  openBoxDesktop(): MaybePromise;
  collectBoxStoreStatus(): MaybePromise;
  snapshotBoxStoreNow(): MaybePromise;
  boxStoreLogs(): MaybePromise;
}

export interface DevControlsHandler<Payload = unknown> {
  readonly trust: "devControlsPanel";
  run(payload: Payload): MaybePromise;
}

export function createDevControlsHandlers(deps: DevControlsHandlerDependencies) {
  const handler = <Payload>(run: (payload: Payload) => MaybePromise): DevControlsHandler<Payload> => ({ trust: "devControlsPanel", run });
  return {
    restartElectron: handler(() => deps.postControl("/restart")),
    reloadWindow: handler(() => deps.postControl("/reload")),
    restartOnboarding: handler(() => deps.postControl("/restart-onboarding")),
    skipOnboarding: handler(() => deps.postControl("/skip-onboarding")),
    themeStatus: handler(() => deps.fetchTheme("")),
    setThemePreference: handler(({ preference }: { preference: string }) => deps.fetchTheme(`?preference=${encodeURIComponent(preference)}`)),
    setWidgetGallery: handler(({ isOn }: { isOn: boolean }) => deps.postControl(`/widget-gallery?on=${isOn === true ? "1" : "0"}`)),
    gatewayOfflineStatus: handler(() => deps.fetchGatewayOffline("")),
    setGatewayOffline: handler(({ induced }: { induced: boolean }) => deps.fetchGatewayOffline(`?induced=${induced === true ? "1" : "0"}`)),
    onePasswordCliStatus: handler(() => deps.onePasswordCli.inspect()),
    prepareOnePasswordCli: handler(() => deps.onePasswordCli.prepare()),
    cancelOnePasswordCliPrepare: handler(() => { deps.onePasswordCli.cancel(); }),
    onePasswordAccounts: handler(() => deps.onePasswordCli.listAccounts()),
    onePasswordVaults: handler(() => deps.onePasswordCli.listVaults()),
    onePasswordFindVault: handler(() => deps.onePasswordCli.findDefaultVault()),
    onePasswordSyntheticProvisioning: handler(() => deps.onePasswordCli.runSyntheticProvisioning()),
    attachProdBoxStatus: handler(() => deps.getAttachProdBoxStatus()),
    setAttachProdBoxEnabled: handler(async ({ enabled, isRestartMainApp }: { enabled: boolean; isRestartMainApp?: boolean }) => {
      deps.writeAttachProdBoxPrefs(enabled === true);
      const status = deps.getAttachProdBoxStatus();
      if (isRestartMainApp !== false) await deps.postControl("/restart");
      return status;
    }),
    boxStatus: handler(() => deps.collectBoxStatus()),
    boxHealth: handler(() => deps.collectBoxHealth()),
    upgradeHost: handler(() => deps.runDevBoxScript("sync")),
    pokeHostUpgrade: handler(() => deps.pokeHostUpgrade()),
    rebuildBox: handler(async () => { await deps.postControl("/box-rebuild-start"); return await deps.runDevBoxScript("rebuild"); }),
    tailLogs: handler(() => deps.tailBoxLogs()),
    startBox: handler(() => deps.runDevBoxScript("up")),
    teardownBox: handler(() => deps.runDevBoxScript("down")),
    nukeBox: handler(() => deps.nukeBox()),
    openDesktop: handler(() => deps.openBoxDesktop()),
    boxStoreStatus: handler(() => deps.collectBoxStoreStatus()),
    boxStoreSnapshotNow: handler(() => deps.snapshotBoxStoreNow()),
    boxStoreLogs: handler(() => deps.boxStoreLogs()),
    boxStoreRecreateFresh: handler(() => deps.runDevBoxScript("recreate-fresh")),
    boxStoreClear: handler(() => deps.runDevBoxScript("clear-store")),
  };
}
