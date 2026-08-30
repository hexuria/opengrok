export function getCursorModelName(part: { providerOptions?: { cursor?: { modelName?: unknown } } }): string | undefined {
  const modelName = part.providerOptions?.cursor?.modelName;
  return typeof modelName === "string" ? modelName : undefined;
}

export function providerOptionsFromModelName(modelName: string | undefined): Record<string, unknown> {
  return modelName === undefined ? {} : { providerOptions: { cursor: { modelName } } };
}
