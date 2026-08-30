import { z } from "zod";

export const widgetActionStyleSchema = z.enum(["default", "primary", "danger"]);

export const choiceOptionSchema = z.object({
  label: z.string().trim().min(1),
  value: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Text sent back to you when this option is picked. Defaults to the label. Make it read like something the user would naturally say in reply.",
    ),
  description: z.string().trim().min(1).optional(),
  style: widgetActionStyleSchema.optional(),
});

export const sandWidgetSchema = z.object({
  prompt: z.string().trim().min(1),
  helpText: z.string().trim().min(1).optional(),
  options: z.array(choiceOptionSchema).min(1).max(6),
  allowCustom: z
    .boolean()
    .optional()
    .describe(
      "When true, the user can type a custom free-text answer instead of choosing one of the options.",
    ),
  dismissOnMoveOn: z
    .boolean()
    .optional()
    .describe(
      "When true, this widget auto-dismisses (becomes inert, shows a muted Dismissed state) once the user sends a newer message without answering it. Omit/false to keep the question live and answerable indefinitely. Set true only for low-stakes questions that become moot if the user moves on; keep it off for real decisions you still need answered.",
    ),
});

export type SandWidget = z.infer<typeof sandWidgetSchema>;

interface WidgetLike {
  readonly prompt?: unknown;
  readonly options?: unknown;
}

export function summarizeWidget(widget: WidgetLike): string {
  const prompt = typeof widget.prompt === "string" ? widget.prompt : "Question";
  const options = Array.isArray(widget.options)
    ? (widget.options as { readonly label?: unknown; readonly value?: unknown }[])
    : [];
  const labels = options.map((option) => option.label).join(" / ");
  return labels.length > 0 ? `${prompt} — ${labels}` : prompt;
}

export function getWidgetAnswerLabel(widget: WidgetLike, answer: string): string {
  const options = Array.isArray(widget.options)
    ? (widget.options as { readonly label?: string; readonly value?: string }[])
    : [];
  const match = options.find((option) => (option.value ?? option.label) === answer);
  return match?.label ?? answer;
}
