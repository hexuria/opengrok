export type SessionDiagnostic = Readonly<Record<string, unknown>> & {
  readonly family: string;
  readonly kind: string;
};

export type SessionDiagnosticsReporter = (report: SessionDiagnostic) => void;

let pinnedReporter: SessionDiagnosticsReporter | null = null;

export function pinSessionDiagnosticsReporter(reporter: SessionDiagnosticsReporter | null): void {
  pinnedReporter = reporter;
}

export function reportSessionDiagnostic(report: SessionDiagnostic): void {
  pinnedReporter?.(report);
}
