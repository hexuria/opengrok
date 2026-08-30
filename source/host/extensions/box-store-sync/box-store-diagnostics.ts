export type BoxStoreDiagnosticReporter = (diagnostic: Record<string, unknown>) => void;
let pinnedReporter: BoxStoreDiagnosticReporter | null = null;
export function pinBoxStoreDiagnosticsReporter(reporter: BoxStoreDiagnosticReporter | null): void { pinnedReporter = reporter; }
export function reportBoxStoreDiagnostic(diagnostic: Record<string, unknown>): void { pinnedReporter?.(diagnostic); }
