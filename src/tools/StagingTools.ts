import { z } from "zod";
import type * as ynab from "ynab";
import type { ToolContext } from "../audit/categoryAudit.js";
const planSchema = { planId: z.string().optional().describe("Selected plan only"), budgetId: z.string().optional().describe("Deprecated selected-plan alias") };
const response = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const stage = (context: ToolContext = {}) => { if (!context.staging) throw new Error("Private staging is not configured"); return context.staging; };
export const statusTool = {
  name: "ynab_staging_status", description: "Shows private plan snapshot freshness, sync cooldown and local rate budget without making a YNAB request.", inputSchema: planSchema,
  async execute(_input: unknown, _api: ynab.API, context: ToolContext = {}) { return response({ success: true, ...(await stage(context).status()) }); },
};
export const syncTool = {
  name: "ynab_sync_plan", description: "On-demand initial or delta sync of the private selected-plan snapshot. Updates local staging only; never writes to YNAB. Concurrent syncs are coalesced and cooldowns enforced.", inputSchema: planSchema,
  async execute(_input: unknown, _api: ynab.API, context: ToolContext = {}) {
    const snapshot = await stage(context).sync();
    return response({ success: true, revision: snapshot.revision, synced_at: snapshot.synced_at, history_since: snapshot.history_since,
      counts: { transactions: snapshot.transactions.length, accounts: snapshot.accounts.length, payees: snapshot.payees.length, category_groups: snapshot.category_groups.length } });
  },
};
export const reviewsTool = {
  name: "ynab_category_review_queue", description: "Lists or annotates durable category proposals, evidence and unresolved questions. A reviewed decision is advisory only: it never authorizes or applies a YNAB change.",
  inputSchema: { ...planSchema, action: z.enum(["list", "update"]).default("list").describe("List proposals or update a local review annotation"), transactionId: z.string().min(1).max(100).optional().describe("Transaction whose saved review should be updated"),
    decision: z.enum(["pending", "reviewed", "dismissed"]).optional().describe("Advisory review decision; never authorizes a YNAB write"), note: z.string().max(2000).optional().describe("Optional private review note, retained up to 30 days"),
    questions: z.array(z.string().max(500)).max(10).optional().describe("Unresolved review questions"), offset: z.number().int().min(0).max(10000).default(0).describe("Review list offset"), limit: z.number().int().min(1).max(100).default(50).describe("Maximum reviews to return") },
  async execute(input: { action?: string; transactionId?: string; decision?: "pending" | "reviewed" | "dismissed"; note?: string; questions?: string[]; offset?: number; limit?: number }, _api: ynab.API, context: ToolContext = {}) {
    const staging = stage(context);
    if (input.action === "update") {
      if (!input.transactionId || !input.decision) throw new Error("Updating a review requires transactionId and decision");
      const existing = (await staging.reviews()).find(row => row.transaction_id === input.transactionId);
      if (!existing) throw new Error("Review not found or expired");
      await staging.updateReview(input.transactionId, input.decision, input.note ?? existing.note, input.questions ?? existing.questions);
    }
    const rows = await staging.reviews(), offset = input.offset ?? 0, limit = input.limit ?? 50;
    return response({ success: true, advisory_only: true, total: rows.length, offset, reviews: rows.slice(offset, offset + limit) });
  },
};
export const clearTool = {
  name: "ynab_clear_staging", description: "Deletes the private staged financial snapshot and review queue, not YNAB data or the R2 audit archive. Rate/cooldown records remain; subsequent reads may resync. Requires explicit confirmation.",
  inputSchema: { ...planSchema, confirm: z.literal(true).describe("Confirm removal of the private staging copy and review queue") },
  async execute(input: { confirm?: boolean }, _api: ynab.API, context: ToolContext = {}) {
    if (input.confirm !== true) throw new Error("Explicit confirmation is required");
    await stage(context).clear(); return response({ success: true, cleared: true, ynab_changed: false });
  },
};
