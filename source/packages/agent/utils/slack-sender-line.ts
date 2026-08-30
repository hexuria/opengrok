export function formatSlackSenderLine(
  senderName?: string,
  senderId?: string,
  senderType?: string,
): string | undefined {
  const name = senderName?.trim();
  const id = senderId?.trim();
  if (
    (name === undefined || name.length === 0) &&
    (id === undefined || id.length === 0)
  ) {
    return undefined;
  }
  const type = senderType?.trim();
  const typeSuffix = type !== undefined && type.length > 0 ? ` (${type})` : "";
  if (name !== undefined && name.length > 0 && id !== undefined && id.length > 0) {
    return `The current message is being sent by ${name} (${id})${typeSuffix}`;
  }
  const present = name !== undefined && name.length > 0 ? name : id;
  return `The current message is being sent by ${present}${typeSuffix}`;
}
