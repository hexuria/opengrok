import type { WindowShortcut } from "./window-shortcuts.js";

export type ApplicationMenuRole =
  | "close"
  | "editMenu"
  | "help"
  | "hide"
  | "hideOthers"
  | "quit"
  | "services"
  | "togglefullscreen"
  | "unhide"
  | "windowMenu";

export interface ApplicationMenuItem {
  readonly label?: string;
  readonly role?: ApplicationMenuRole;
  readonly type?: "separator";
  readonly accelerator?: string;
  readonly click?: () => void;
  readonly submenu?: readonly ApplicationMenuItem[];
}

export interface ApplicationMenuElectronPort {
  readonly appName: string;
  readonly buildFromTemplate: (template: readonly ApplicationMenuItem[]) => unknown;
  readonly setApplicationMenu: (menu: unknown) => void;
  readonly openExternal: (url: string) => Promise<unknown>;
}

export interface ApplicationMenuOptions {
  readonly applyWindowShortcut: (shortcut: WindowShortcut) => void;
  readonly canUseDevTools: () => boolean;
  readonly emitOpenAbout: () => void;
  readonly emitOpenFeedback: () => void;
  readonly platform?: NodeJS.Platform;
}

export function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions,
  electron: Pick<ApplicationMenuElectronPort, "appName" | "openExternal">,
): ApplicationMenuItem[] {
  const isMac = (options.platform ?? process.platform) === "darwin";
  const template: ApplicationMenuItem[] = [];
  if (isMac) {
    template.push({
      label: electron.appName,
      submenu: [
        { label: `About ${electron.appName}`, click: () => options.emitOpenAbout() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push({
    label: "File",
    submenu: [isMac ? { role: "close" } : { role: "quit" }],
  });
  template.push({ role: "editMenu" });
  const viewSubmenu: ApplicationMenuItem[] = [
    {
      label: "Reload",
      accelerator: "CmdOrCtrl+R",
      click: () => options.applyWindowShortcut("reload"),
    },
  ];
  if (options.canUseDevTools()) {
    viewSubmenu.push(
      { type: "separator" },
      {
        label: "Toggle Developer Tools",
        accelerator: isMac ? "Cmd+Alt+I" : "Ctrl+Shift+I",
        click: () => options.applyWindowShortcut("toggledevtools"),
      },
    );
  }
  viewSubmenu.push(
    { type: "separator" },
    isMac
      ? { role: "togglefullscreen" }
      : {
          label: "Toggle Full Screen",
          accelerator: "F11",
          click: () => options.applyWindowShortcut("fullscreen"),
        },
  );
  template.push({ label: "View", submenu: viewSubmenu });
  template.push({ role: "windowMenu" });
  template.push({
    role: "help",
    submenu: [
      {
        label: "Help Center",
        click: () => {
          void electron.openExternal("https://cursor.com/help");
        },
      },
      { type: "separator" },
      { label: "Send Feedback", click: () => options.emitOpenFeedback() },
    ],
  });
  return template;
}

export function installApplicationMenu(
  options: ApplicationMenuOptions,
  electron: ApplicationMenuElectronPort,
): void {
  const template = buildApplicationMenuTemplate(options, electron);
  electron.setApplicationMenu(electron.buildFromTemplate(template));
}
