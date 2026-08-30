let preserveComputersAcrossAccountDeparture = false;

export function setPreserveComputersAcrossAccountDeparture(enabled: boolean): void {
  preserveComputersAcrossAccountDeparture = enabled;
}

export function shouldPreserveComputersAcrossAccountDeparture(): boolean {
  return preserveComputersAcrossAccountDeparture;
}

export async function withPreservedComputers<T>(work: () => Promise<T>): Promise<T> {
  setPreserveComputersAcrossAccountDeparture(true);
  try {
    return await work();
  } finally {
    setPreserveComputersAcrossAccountDeparture(false);
  }
}
