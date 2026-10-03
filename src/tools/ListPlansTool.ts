import type { ToolContext } from "../audit/categoryAudit.js";
import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage, toolError } from "./errorUtils.js";

export const name = "ynab_list_plans";
export const description = "Lists all available plans from YNAB API";
export const inputSchema = {};

export async function execute(_input: Record<string, unknown>, api: ynab.API, context: ToolContext = {}) {
  try {
    if (!process.env.YNAB_API_TOKEN) {
      return toolError("YNAB API Token is not set");
    }

    if (context.allowedPlanId) {
      const { data } = await api.plans.getPlanById(context.allowedPlanId);
      return { content: [{ type: "text" as const, text: JSON.stringify([{ id: data.plan.id, name: data.plan.name }], null, 2) }] };
    }
    console.error("Listing plans");
    const plansResponse = await api.plans.getPlans();
    console.error(`Found ${plansResponse.data.plans.length} plans`);

    const plans = plansResponse.data.plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(plans, null, 2) }]
    };
  } catch (error: unknown) {
    console.error("Error listing plans:", error);
    return toolError(getErrorMessage(error));
  }
}