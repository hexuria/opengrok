import type { SandThemePreference } from "../../shared/desktop.js";

export type SandResolvedTheme = "light" | "dark";
export interface SandThemeState { readonly preference: SandThemePreference; readonly resolved: SandResolvedTheme }
export interface SandThemeSettingsStore {
  getThemePreference(): SandThemePreference;
  setThemePreference(preference: SandThemePreference): void;
}
export interface NativeThemePort {
  themeSource: SandThemePreference;
  readonly shouldUseDarkColors: boolean;
  on(event: "updated", listener: () => void): void;
  removeListener(event: "updated", listener: () => void): void;
}

export const WINDOW_BACKGROUND_BY_THEME: Readonly<Record<SandResolvedTheme, string>> = {
  light: "#FCFCFC",
  dark: "#0B0B0B",
};

export function windowBackgroundColorForResolvedTheme(theme: SandResolvedTheme): string {
  return WINDOW_BACKGROUND_BY_THEME[theme];
}

export class SandThemeController {
  readonly #settingsStore: SandThemeSettingsStore;
  readonly #broadcastState: (state: SandThemeState) => void;
  readonly #nativeTheme: NativeThemePort;
  #disposed = false;

  constructor(settingsStore: SandThemeSettingsStore, broadcastState: (state: SandThemeState) => void, nativeTheme: NativeThemePort) {
    this.#settingsStore = settingsStore;
    this.#broadcastState = broadcastState;
    this.#nativeTheme = nativeTheme;
    this.#nativeTheme.themeSource = this.#settingsStore.getThemePreference();
    this.#nativeTheme.on("updated", this.#handleNativeThemeUpdated);
  }

  getState(): SandThemeState {
    return { preference: this.#settingsStore.getThemePreference(), resolved: this.#resolveTheme() };
  }

  setPreference(preference: SandThemePreference): SandThemeState {
    this.#settingsStore.setThemePreference(preference);
    this.#nativeTheme.themeSource = preference;
    return this.getState();
  }

  getWindowBackgroundColor(): string {
    return windowBackgroundColorForResolvedTheme(this.#resolveTheme());
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#nativeTheme.removeListener("updated", this.#handleNativeThemeUpdated);
  }

  readonly #handleNativeThemeUpdated = (): void => {
    if (!this.#disposed) this.#broadcastState(this.getState());
  };
  #resolveTheme(): SandResolvedTheme { return this.#nativeTheme.shouldUseDarkColors ? "dark" : "light"; }
}
