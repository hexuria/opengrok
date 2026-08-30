export interface DesktopEdgeFailure {
  readonly area: string;
  readonly leg: string;
  readonly errorClass: string;
}

export type DesktopEdgeFailureReporter = (failure: DesktopEdgeFailure) => void;

const PRE_INSTALL_BUFFER_CAP = 32;

let reporter: DesktopEdgeFailureReporter | null = null;
let pendingPreInstall: DesktopEdgeFailure[] = [];

export function installDesktopEdgeFailureReporter(next: DesktopEdgeFailureReporter | null): void {
  reporter = next;
  const flush = pendingPreInstall;
  pendingPreInstall = [];
  if (next == null) return;
  for (const failure of flush) next(failure);
}

export function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return error.name.length > 0 ? error.name : "Error";
}

export function reportDesktopEdgeFailure(area: string, leg: string, error: unknown): void {
  reportDesktopEdgeFailureClass(area, leg, errorClassOf(error));
}

export function reportDesktopEdgeFailureClass(area: string, leg: string, errorClass: string): void {
  const failure = { area, leg, errorClass };
  if (reporter != null) {
    reporter(failure);
    return;
  }
  if (pendingPreInstall.length >= PRE_INSTALL_BUFFER_CAP) return;
  pendingPreInstall.push(failure);
}
