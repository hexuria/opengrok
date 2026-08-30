export const MESSAGE_ADDRESS_EXACT = /^t(?:\d+u(?:a\d+)?|(?:\d+|b)[as]\d+)$/;

export function isMessageAddress(value: string): boolean {
  return MESSAGE_ADDRESS_EXACT.test(value);
}
