export interface EnvironmentScopedItem {
  readonly disabledEnvironments?: readonly string[] | undefined;
  readonly environments?: readonly string[] | undefined;
}

function isEnvironmentEligible(item: EnvironmentScopedItem, targetEnv: string): boolean {
  const disabledEnvironments = item.disabledEnvironments ?? [];
  if (disabledEnvironments.includes(targetEnv)) {
    return false;
  }
  const environments = item.environments ?? [];
  if (environments.length === 0) {
    return true;
  }
  return environments.includes(targetEnv);
}

export function filterByEnvironment<T extends EnvironmentScopedItem>(items: T[], targetEnv: string): T[] {
  return items.filter((item) => isEnvironmentEligible(item, targetEnv));
}
