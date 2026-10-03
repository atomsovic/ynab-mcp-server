import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ynab from "ynab";
import { registerAll } from "../registry.js";
import { accessPolicy } from "../accessPolicy.js";

const plan = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
afterEach(() => vi.unstubAllEnvs());
function registered(api: unknown, overrides = {}) {
  const callbacks = new Map<string, (args: any) => Promise<any>>();
  registerAll({ registerTool(name, _config, cb) { callbacks.set(name, cb); } }, api as ynab.API,
    { allowedPlanId: plan, toolMode: "category-only", ...overrides });
  return callbacks;
}
function output(result: any) { return JSON.parse(result.content[0].text); }

describe("selected plan and tool access", () => {
  it.each([{}, { planId: plan }, { budgetId: plan }, { planId: null, budgetId: null }])("pins omitted and matching IDs %j", async input => {
    vi.stubEnv("YNAB_PLAN_ID", other);
    const getCategories = vi.fn().mockResolvedValue({ data: { category_groups: [] } });
    const tool = registered({ categories: { getCategories } }).get("ynab_list_categories")!;
    expect(output(await tool(input)).success).not.toBe(false);
    expect(getCategories).toHaveBeenCalledWith(plan);
  });
  it.each([{ planId: other }, { budgetId: other }, { planId: plan, budgetId: other }, { planId: "last-used" }, { planId: "" }, { planId: "../other" }])("rejects alternate IDs before reads or writes %j", async input => {
    const getCategories = vi.fn();
    const entries = registered({ categories: { getCategories } });
    for (const name of ["ynab_list_categories", "ynab_apply_category_suggestions"]) {
      expect(output(await entries.get(name)!({ ...input, suggestions: [] })).success).toBe(false);
    }
    expect(getCategories).not.toHaveBeenCalled();
  });
  it("exposes reads and only audited category apply, with read-only overriding it", () => {
    const names = [...registered({}).keys()];
    expect(names).toContain("ynab_apply_category_suggestions");
    for (const name of ["ynab_create_transaction", "ynab_update_transaction", "ynab_import_transactions", "ynab_delete_transaction", "ynab_approve_transaction", "ynab_bulk_approve_transactions", "ynab_auto_assign", "ynab_move_money", "ynab_update_category_budget"]) expect(names).not.toContain(name);
    expect([...registered({}, { readOnly: true }).keys()]).not.toContain("ynab_apply_category_suggestions");
  });
  it("does not fetch or enumerate other plans", async () => {
    vi.stubEnv("YNAB_API_TOKEN", "synthetic");
    const getPlans = vi.fn();
    const getPlanById = vi.fn().mockResolvedValue({ data: { plan: { id: plan, name: "Selected" } } });
    const entries = registered({ plans: { getPlans, getPlanById } });
    for (const name of ["ynab_list_plans", "ynab_list_budgets"]) expect(output(await entries.get(name)!({}))).toEqual([{ id: plan, name: "Selected" }]);
    expect(getPlanById).toHaveBeenCalledWith(plan);
    expect(getPlans).not.toHaveBeenCalled();
  });
  it("does not return audit records for other plans", async () => {
    const categoryAudit = { read: vi.fn().mockResolvedValue({ plan_id: other, rows: [{ sensitive: "other-budget" }] }) };
    const result = output(await registered({}, { categoryAudit }).get("ynab_get_category_audit")!({ operation_id: crypto.randomUUID() }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("other-budget");
  });
});

describe("access configuration", () => {
  it("defaults to the restricted category mode", () => expect(accessPolicy({ YNAB_ALLOWED_PLAN_ID: plan })).toEqual({ allowedPlanId: plan, toolMode: "category-only", readOnly: false }));
  it.each([{}, { YNAB_ALLOWED_PLAN_ID: "last-used" }, { YNAB_ALLOWED_PLAN_ID: plan, YNAB_PLAN_ID: other }, { YNAB_ALLOWED_PLAN_ID: plan, YNAB_BUDGET_ID: other }, { YNAB_ALLOWED_PLAN_ID: plan, YNAB_TOOL_MODE: "typo" }, { YNAB_ALLOWED_PLAN_ID: plan, YNAB_READ_ONLY: "TRUE" }])("fails closed for invalid configuration %j", env => expect(() => accessPolicy(env)).toThrow());
  it("preserves explicit full mode and read-only override within one plan", () => expect(accessPolicy({ YNAB_ALLOWED_PLAN_ID: plan, YNAB_TOOL_MODE: "full", YNAB_READ_ONLY: "true" })).toEqual({ allowedPlanId: plan, toolMode: "full", readOnly: true }));
});
