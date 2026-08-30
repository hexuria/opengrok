export const MAX_TOOL_ANNOTATION_TITLE_LENGTH = 256;

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export function toolAnnotationsJsonField(annotations: ToolAnnotations | undefined): { annotationsJson?: string } {
  if (annotations === undefined) return {};
  const bounded: ToolAnnotations = {};
  if (typeof annotations.title === "string" && annotations.title.length > 0) {
    bounded.title = annotations.title.slice(0, MAX_TOOL_ANNOTATION_TITLE_LENGTH);
  }
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    if (typeof annotations[key] === "boolean") bounded[key] = annotations[key];
  }
  return Object.keys(bounded).length === 0 ? {} : { annotationsJson: JSON.stringify(bounded) };
}
