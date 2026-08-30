export interface SandBoxMigrationOperationId {
  readonly value: string;
}

export function parseSandBoxMigrationOperationId(
  value: unknown,
): SandBoxMigrationOperationId | null {
  return typeof value === "string" && value.length > 0 ? { value } : null;
}

export function isSameSandBoxMigrationOperation(
  left: SandBoxMigrationOperationId | null | undefined,
  right: SandBoxMigrationOperationId | null | undefined,
): boolean {
  return left != null && right != null && left.value === right.value;
}
