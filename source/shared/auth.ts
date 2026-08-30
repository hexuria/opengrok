export interface CursorAccountStatus {
  readonly kind: string;
  readonly authId?: string;
  readonly email?: string;
  readonly [key: string]: unknown;
}

export function cursorAccountSlot(status: CursorAccountStatus): string | null {
  if (status.kind !== "logged-in") return null;
  const slot = status.authId ?? status.email;
  return slot == null || slot.length === 0 ? null : slot;
}
