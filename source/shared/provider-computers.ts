import { isSandInferenceProvider, type SandInferenceProvider } from "./inference-router.js";
import { isSandBoxRuntime, type SandBoxRuntime } from "./box-runtime.js";

export const PROVIDER_COMPUTER_KINDS = ["local-docker", "grok-vm", "windows-365", "box"] as const;
export type ProviderComputerKind = (typeof PROVIDER_COMPUTER_KINDS)[number];

export interface ProviderComputerDefinition {
  readonly id: ProviderComputerKind;
  readonly label: string;
  readonly description: string;
  readonly wiring: "live" | "placeholder";
  readonly cursorOnly?: boolean;
}

export const PROVIDER_COMPUTER_DEFINITIONS: readonly ProviderComputerDefinition[] = [
  {
    id: "local-docker",
    label: "Local Docker VM",
    description: "Shell, files, and computer use run in a Docker container on this machine.",
    wiring: "live",
  },
  {
    id: "grok-vm",
    label: "Grok VM",
    description: "The hosted Grok Bot computer. Available when the provider is Cursor.",
    wiring: "placeholder",
    cursorOnly: true,
  },
  {
    id: "windows-365",
    label: "Windows 365",
    description: "A Cloud PC screen. This reconstruction has no Windows 365 provision API yet.",
    wiring: "placeholder",
  },
  {
    id: "box",
    label: "box (Linux VM)",
    description: "The existing Grok Bot Linux computer / remote box path.",
    wiring: "live",
  },
];

export interface ProviderComputerConfig {
  readonly activated: readonly ProviderComputerKind[];
  readonly selectedScreen: ProviderComputerKind | null;
}

export type ProviderComputerMap = Record<SandInferenceProvider, ProviderComputerConfig>;

export const EMPTY_PROVIDER_COMPUTER_CONFIG: ProviderComputerConfig = { activated: [], selectedScreen: null };

export function isProviderComputerKind(value: unknown): value is ProviderComputerKind {
  return typeof value === "string" && (PROVIDER_COMPUTER_KINDS as readonly string[]).includes(value);
}

export function providerComputerDefinition(id: ProviderComputerKind): ProviderComputerDefinition {
  return PROVIDER_COMPUTER_DEFINITIONS.find((item) => item.id === id) ?? PROVIDER_COMPUTER_DEFINITIONS[0]!;
}

export function emptyProviderComputerMap(): ProviderComputerMap {
  return {
    cursor: { ...EMPTY_PROVIDER_COMPUTER_CONFIG },
    "claude-code": { ...EMPTY_PROVIDER_COMPUTER_CONFIG },
    codex: { ...EMPTY_PROVIDER_COMPUTER_CONFIG },
    openrouter: { ...EMPTY_PROVIDER_COMPUTER_CONFIG },
  };
}

export function computerAllowedForProvider(provider: SandInferenceProvider, kind: ProviderComputerKind): boolean {
  const definition = providerComputerDefinition(kind);
  return definition.cursorOnly !== true || provider === "cursor";
}

export function normalizeActivatedComputers(
  provider: SandInferenceProvider,
  activated: readonly unknown[],
): ProviderComputerKind[] {
  const seen = new Set<ProviderComputerKind>();
  const next: ProviderComputerKind[] = [];
  for (const value of activated) {
    if (!isProviderComputerKind(value) || seen.has(value) || !computerAllowedForProvider(provider, value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
}

export function resolveSelectedComputerScreen(
  provider: SandInferenceProvider,
  config: ProviderComputerConfig,
  requested?: ProviderComputerKind | null,
): ProviderComputerKind | null {
  const activated = normalizeActivatedComputers(provider, config.activated);
  if (activated.length === 0) return null;
  if (requested != null && activated.includes(requested)) return requested;
  if (config.selectedScreen != null && activated.includes(config.selectedScreen)) return config.selectedScreen;
  return activated[0] ?? null;
}

export function activateProviderComputer(
  provider: SandInferenceProvider,
  config: ProviderComputerConfig,
  kind: ProviderComputerKind,
  enabled: boolean,
): ProviderComputerConfig {
  if (!computerAllowedForProvider(provider, kind)) {
    return {
      activated: normalizeActivatedComputers(provider, config.activated),
      selectedScreen: resolveSelectedComputerScreen(provider, config),
    };
  }
  const current = new Set(normalizeActivatedComputers(provider, config.activated));
  if (enabled) current.add(kind);
  else current.delete(kind);
  const activated = [...current];
  const next = { activated, selectedScreen: config.selectedScreen };
  return { activated, selectedScreen: resolveSelectedComputerScreen(provider, next) };
}

export function selectProviderComputerScreen(
  provider: SandInferenceProvider,
  config: ProviderComputerConfig,
  screen: ProviderComputerKind,
): ProviderComputerConfig {
  const activated = normalizeActivatedComputers(provider, config.activated);
  if (!activated.includes(screen)) return { activated, selectedScreen: resolveSelectedComputerScreen(provider, { activated, selectedScreen: config.selectedScreen }) };
  return { activated, selectedScreen: screen };
}

export function parseProviderComputerMap(value: unknown): ProviderComputerMap {
  const result = emptyProviderComputerMap();
  if (typeof value !== "object" || value == null || Array.isArray(value)) return result;
  for (const provider of Object.keys(result) as SandInferenceProvider[]) {
    const raw = (value as Record<string, unknown>)[provider];
    if (typeof raw !== "object" || raw == null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const activated = normalizeActivatedComputers(provider, Array.isArray(record.activated) ? record.activated : []);
    result[provider] = {
      activated,
      selectedScreen: resolveSelectedComputerScreen(provider, {
        activated,
        selectedScreen: isProviderComputerKind(record.selectedScreen) ? record.selectedScreen : null,
      }),
    };
  }
  return result;
}

export function migrateBoxRuntimeIntoProviderComputers(
  provider: SandInferenceProvider,
  boxRuntime: SandBoxRuntime | undefined,
  stored?: ProviderComputerMap,
): ProviderComputerMap {
  const map = stored == null ? emptyProviderComputerMap() : parseProviderComputerMap(stored);
  const hasAny = (Object.values(map) as ProviderComputerConfig[]).some((config) => config.activated.length > 0);
  if (hasAny) return map;
  const kind: ProviderComputerKind = boxRuntime === "local-docker" ? "local-docker" : "box";
  const current = activateProviderComputer(provider, map[provider], kind, true);
  return { ...map, [provider]: current };
}

export function boxRuntimeForScreen(screen: ProviderComputerKind | null): SandBoxRuntime {
  return screen === "local-docker" ? "local-docker" : "remote";
}

export function screenSwitcherOptions(
  provider: SandInferenceProvider,
  config: ProviderComputerConfig,
): readonly ProviderComputerDefinition[] {
  return normalizeActivatedComputers(provider, config.activated).map(providerComputerDefinition);
}

export function providerSwitchMustNotTouchComputer(): {
  readonly restartCoordinator: false;
  readonly recreateComputer: false;
  readonly markUnreachable: false;
  readonly recoverComputer: false;
} {
  return { restartCoordinator: false, recreateComputer: false, markUnreachable: false, recoverComputer: false };
}

export function isSandInferenceProviderId(value: unknown): value is SandInferenceProvider {
  return isSandInferenceProvider(value);
}

export function isSandBoxRuntimeId(value: unknown): value is SandBoxRuntime {
  return isSandBoxRuntime(value);
}
