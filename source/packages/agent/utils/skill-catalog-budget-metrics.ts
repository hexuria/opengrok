import type { Context } from "../../context/core.js";
import { createCounter, createHistogram } from "../../metrics/index.js";

interface SkillCatalogBudgetMetricsInput {
  readonly strategy: string;
  readonly renderedTokens: number;
  readonly uncappedTokens: number;
  readonly omittedCount: number;
}

const skillCatalogBudgetApplied = createCounter("skill_catalog_budget.applied", {
  description:
    "Model invocations that ran the skill-catalog budget pipeline, tagged by which strategy was selected",
  labelNames: ["strategy"],
});
const skillCatalogBudgetRenderedTokens = createHistogram(
  "skill_catalog_budget.rendered_tokens",
  {
    description:
      "Estimated tokens rendered for the skill catalog after budgeting, tagged by strategy",
    labelNames: ["strategy"],
  },
);
const skillCatalogBudgetUncappedTokens = createHistogram(
  "skill_catalog_budget.uncapped_tokens",
  {
    description:
      "Estimated tokens the skill catalog would have rendered with no budget applied, tagged by the strategy that ran",
    labelNames: ["strategy"],
  },
);
const skillCatalogBudgetOmittedCount = createHistogram(
  "skill_catalog_budget.omitted_count",
  {
    description: "Number of skills omitted from the rendered catalog, tagged by strategy",
    labelNames: ["strategy"],
  },
);

export function emitSkillCatalogBudgetMetrics(
  ctx: Context,
  input: SkillCatalogBudgetMetricsInput,
): void {
  const tags = { strategy: input.strategy };
  skillCatalogBudgetApplied.increment(ctx, 1, tags);
  skillCatalogBudgetRenderedTokens.histogram(ctx, input.renderedTokens, tags);
  skillCatalogBudgetUncappedTokens.histogram(ctx, input.uncappedTokens, tags);
  skillCatalogBudgetOmittedCount.histogram(ctx, input.omittedCount, tags);
}
