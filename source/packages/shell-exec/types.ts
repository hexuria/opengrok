export enum KnownShellExecutor { Zsh = "zsh", ZshLight = "zsh-light", Bash = "bash", PowerShell = "powershell", Naive = "naive" }
export const SHELL_ENV_OVERRIDES = { TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", _ZO_DOCTOR: "0" } as const;
