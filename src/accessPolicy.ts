export type ToolMode = "category-only" | "read-only" | "full";
export interface AccessPolicy { allowedPlanId: string; toolMode: ToolMode; readOnly: boolean }
export interface AccessEnvironment {
  YNAB_ALLOWED_PLAN_ID?: string;
  YNAB_PLAN_ID?: string;
  YNAB_BUDGET_ID?: string;
  YNAB_TOOL_MODE?: string;
  YNAB_READ_ONLY?: string;
}

export function accessPolicy(env: AccessEnvironment): AccessPolicy {
  const allowedPlanId = env.YNAB_ALLOWED_PLAN_ID;
  if (!allowedPlanId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(allowedPlanId)) {
    throw new Error("YNAB_ALLOWED_PLAN_ID must be one explicit lowercase plan UUID");
  }
  if ([env.YNAB_PLAN_ID, env.YNAB_BUDGET_ID].some(id => id !== undefined && id !== allowedPlanId)) {
    throw new Error("Default plan aliases must match YNAB_ALLOWED_PLAN_ID");
  }
  const toolMode = env.YNAB_TOOL_MODE ?? "category-only";
  if (!["category-only", "read-only", "full"].includes(toolMode)) throw new Error("Invalid YNAB_TOOL_MODE");
  if (env.YNAB_READ_ONLY !== undefined && !["true", "false"].includes(env.YNAB_READ_ONLY)) throw new Error("Invalid YNAB_READ_ONLY");
  return { allowedPlanId, toolMode: toolMode as ToolMode, readOnly: env.YNAB_READ_ONLY === "true" || toolMode === "read-only" };
}

/** Explicitly reviewed read surface; new registry entries do not silently expand safe mode. */
export const CATEGORY_READ_TOOLS = new Set([
  "ynab_list_plans", "ynab_list_budgets", "ynab_get_unapproved_transactions",
  "ynab_plan_summary", "ynab_budget_summary", "ynab_list_payees", "ynab_get_transactions",
  "ynab_list_categories", "ynab_list_accounts", "ynab_list_scheduled_transactions", "ynab_list_months",
  "ynab_spending_by_payee", "ynab_spending_by_category", "ynab_cash_flow",
  "ynab_suggest_categories", "ynab_get_category_audit",
  "ynab_staging_status", "ynab_sync_plan", "ynab_category_review_queue", "ynab_clear_staging",
]);
