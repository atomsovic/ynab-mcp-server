import { describe, expect, it } from "vitest";
import * as AuditTool from "../tools/GetCategoryAuditTool.js";
import type { CategoryAuditRecord, CategoryAuditStore } from "../audit/categoryAudit.js";
import type * as ynab from "ynab";

const operationId = "00000000-0000-4000-8000-000000000001";
const prepared: CategoryAuditRecord = { version: 1, operation_id: operationId, phase: "prepared", recorded_at: "2026-10-03T00:00:00Z", plan_id: "synthetic", dry_run: false, rows: [], undo_manifest: [] };
const api = {} as ynab.API;
function output(response: Awaited<ReturnType<typeof AuditTool.execute>>) { return JSON.parse(response.content[0].text); }

describe("GetCategoryAuditTool", () => {
  it.each([false, true])("reports outcome presence accurately: %s", async complete => {
    const store: CategoryAuditStore = {
      async write() {},
      async read(_id, phase) { return phase === "prepared" ? prepared : complete ? { ...prepared, phase } : null; },
    };
    const result = output(await AuditTool.execute({ operation_id: operationId }, api, { categoryAudit: store }));
    expect(result).toMatchObject({ success: true, status: complete ? "recorded" : "needs_reconciliation", prepared });
    expect(result.outcome).toEqual(complete ? { ...prepared, phase: "outcome" } : null);
  });
  it("reports missing storage, absent records, and unreadable storage as errors", async () => {
    expect(output(await AuditTool.execute({ operation_id: operationId }, api)).success).toBe(false);
    const store: CategoryAuditStore = { async write() {}, async read() { return null; } };
    expect(output(await AuditTool.execute({ operation_id: operationId }, api, { categoryAudit: store })).success).toBe(false);
    store.read = async () => { throw new Error("private details"); };
    const result = output(await AuditTool.execute({ operation_id: operationId }, api, { categoryAudit: store }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private details");
  });
});
