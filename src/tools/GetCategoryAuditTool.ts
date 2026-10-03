import { z } from "zod";
import type * as ynab from "ynab";
import type { ToolContext } from "../audit/categoryAudit.js";
import { toolError } from "./errorUtils.js";

export const name = "ynab_get_category_audit";
export const description = "Reads a persisted category application audit by operation ID without contacting YNAB. A preparation without an outcome requires manual reconciliation; it does not prove whether a write occurred.";
export const inputSchema = {
  operation_id: z.uuidv4().describe("Operation ID returned by ynab_apply_category_suggestions"),
};

export async function execute(input: { operation_id: string }, _api: ynab.API, context: ToolContext = {}) {
  const store = context.categoryAudit;
  if (!store) return toolError("Category audit storage is not configured");
  try {
    const prepared = await store.read(input.operation_id, "prepared");
    if (!prepared || (context.allowedPlanId && prepared.plan_id !== context.allowedPlanId)) return toolError("Category audit operation not found");
    const outcome = await store.read(input.operation_id, "outcome");
    return { content: [{ type: "text" as const, text: JSON.stringify({
      success: true, operation_id: input.operation_id,
      status: outcome ? "recorded" : "needs_reconciliation", prepared, outcome,
    }, null, 2) }] };
  } catch { return toolError("Category audit could not be read; check storage availability and record integrity"); }
}
