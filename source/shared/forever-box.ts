export interface SandBoxHandoff {
  readonly requestId: string;
}

export type SandBoxHandBackTrigger = "dismissed" | string;

export type SandBoxHandBackDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: "resume";
      readonly requestId: string;
      readonly trigger: string;
      readonly resolution: "dismissed" | "handed_back";
    };

export function decideBoxHandBack(
  handoff: SandBoxHandoff | null | undefined,
  trigger: SandBoxHandBackTrigger,
): SandBoxHandBackDecision {
  if (handoff == null) return { kind: "none" };
  return {
    kind: "resume",
    requestId: handoff.requestId,
    trigger,
    resolution: trigger === "dismissed" ? "dismissed" : "handed_back",
  };
}
