import { describe, expect, it, vi } from "vitest";
import * as ynab from "ynab";

import * as ApplyTool from "../tools/ApplyCategorySuggestionsTool.js";
import type { CategoryAuditRecord, CategoryAuditStore } from "../audit/categoryAudit.js";
import { contentFingerprint } from "../tools/SuggestCategoriesTool.js";

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "txn-1",
    date: "2026-09-12",
    amount: -12500,
    memo: "weekly shop",
    cleared: "cleared",
    approved: false,
    account_id: "account-uuid",
    account_name: "Checking",
    payee_id: "payee-uuid",
    payee_name: "Market",
    category_id: null,
    category_name: null,
    transfer_account_id: null,
    import_payee_name: "MARKET 123",
    import_payee_name_original: "MARKET #123",
    subtransactions: [],
    deleted: false,
    ...overrides,
  };
}

function makeApi(currentTransaction: ReturnType<typeof transaction>) {
  return {
    transactions: {
      getTransactionById: vi.fn().mockResolvedValue({
        data: { transaction: currentTransaction },
      }),
      updateTransactions: vi.fn(),
    },
    categories: {
      getCategories: vi.fn().mockResolvedValue({
        data: {
          category_groups: [{
            id: "group-everyday",
            name: "Everyday",
            hidden: false,
            deleted: false,
            categories: [{
              id: "cat-grocery",
              category_group_id: "group-everyday",
              name: "Groceries",
              hidden: false,
              deleted: false,
              budgeted: 0,
              activity: 0,
              balance: 0,
            }],
          }],
        },
      }),
    },
  };
}

async function execute(
  currentTransaction: ReturnType<typeof transaction>,
  expectedFingerprint: string,
  options: { dryRun?: boolean; updatedTransaction?: ReturnType<typeof transaction> } = {},
) {
  const api = makeApi(currentTransaction);
  if (options.updatedTransaction) {
    api.transactions.updateTransactions.mockResolvedValue({
      data: { transactions: [options.updatedTransaction] },
    });
  }
  const response = await ApplyTool.execute({
    planId: "plan-id",
    dry_run: options.dryRun,
    suggestions: [{
      transaction_id: "txn-1",
      category_id: "cat-grocery",
      expected_content_fingerprint: expectedFingerprint,
    }],
  }, api as unknown as ynab.API, { categoryAudit: memoryStore() });

  return { api, output: JSON.parse(response.content[0].text) };
}

describe("ApplyCategorySuggestionsTool", () => {
  it("applies an explicit suggestion without approving and returns its undo manifest", async () => {
    const currentTransaction = transaction();
    const expectedFingerprint = await contentFingerprint(currentTransaction as ynab.TransactionDetail);
    const { api, output } = await execute(currentTransaction, expectedFingerprint, {
      updatedTransaction: transaction({ category_id: "cat-grocery", category_name: "Groceries" }),
    });

    expect(api.transactions.updateTransactions).toHaveBeenCalledWith("plan-id", {
      transactions: [{ id: "txn-1", category_id: "cat-grocery" }],
    });
    expect(output).toMatchObject({
      success: true,
      dry_run: false,
      undo_manifest: [{
        transaction_id: "txn-1",
        category_id: null,
        approved: false,
        requested_category_id: "cat-grocery",
      }],
      rows: [{ transaction_id: "txn-1", status: "applied" }],
    });
  });

  it("validates a dry run and does not write", async () => {
    const currentTransaction = transaction();
    const expectedFingerprint = await contentFingerprint(currentTransaction as ynab.TransactionDetail);
    const { api, output } = await execute(currentTransaction, expectedFingerprint, { dryRun: true });

    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      success: true,
      dry_run: true,
      undo_manifest: [{ transaction_id: "txn-1", category_id: null, approved: false }],
      rows: [{ transaction_id: "txn-1", status: "would_apply" }],
    });
  });

  it("rejects a stale suggestion without writing", async () => {
    const expectedFingerprint = await contentFingerprint(transaction({ memo: "old memo" }) as ynab.TransactionDetail);
    const { api, output } = await execute(transaction({ memo: "changed memo" }), expectedFingerprint);

    expect(output.rows).toEqual([expect.objectContaining({
      transaction_id: "txn-1",
      status: "rejected",
      reason: "fingerprint_mismatch",
    })]);
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
  });

  it("treats a retried successful suggestion as already applied", async () => {
    const expectedFingerprint = await contentFingerprint(transaction() as ynab.TransactionDetail);
    const { api, output } = await execute(
      transaction({ category_id: "cat-grocery", category_name: "Groceries" }),
      expectedFingerprint,
    );

    expect(output.rows).toEqual([expect.objectContaining({
      transaction_id: "txn-1",
      status: "already_applied",
    })]);
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
  });

  it.each([
    ["approved", { approved: true }, "approved"],
    ["reconciled", { cleared: "reconciled" }, "reconciled"],
    ["deleted", { deleted: true }, "deleted"],
  ])("rejects a %s transaction refetched before apply", async (_state, overrides, reason) => {
    const currentTransaction = transaction(overrides);
    const expectedFingerprint = await contentFingerprint(currentTransaction as ynab.TransactionDetail);
    const { api, output } = await execute(currentTransaction, expectedFingerprint);

    expect(output.rows).toEqual([expect.objectContaining({
      transaction_id: "txn-1",
      status: "rejected",
      reason,
    })]);
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
  });
});

function memoryStore(): CategoryAuditStore & { records: CategoryAuditRecord[] } {
  const records: CategoryAuditRecord[] = [];
  return {
    records,
    async write(record) { records.push(structuredClone(record)); },
    async read(id, phase) { return records.find(r => r.operation_id === id && r.phase === phase) ?? null; },
  };
}

async function auditedCase(options: {
  store?: CategoryAuditStore; missingStore?: boolean; dryRun?: boolean;
  transactions?: ReturnType<typeof transaction>[]; response?: unknown; throws?: boolean;
} = {}) {
  const txns = options.transactions ?? [transaction()];
  const api = makeApi(txns[0]);
  api.transactions.getTransactionById.mockImplementation(async (_plan, id) => ({
    data: { transaction: txns.find(t => t.id === id)! },
  }));
  const store = options.missingStore ? undefined : options.store ?? memoryStore();
  api.transactions.updateTransactions.mockImplementation(async () => {
    // This assertion is part of the API boundary, before a simulated write.
    const records = store && "records" in store ? (store as ReturnType<typeof memoryStore>).records : [];
    if (records.length) expect(records[0]).toMatchObject({
      phase: "prepared", undo_manifest: expect.arrayContaining([{ transaction_id: "txn-1", category_id: null, approved: false, requested_category_id: "cat-grocery" }]),
    });
    if (options.throws) throw new Error("synthetic credential must not be persisted");
    return options.response ?? { data: { transactions: txns.map(t => ({ ...t, category_id: "cat-grocery" })) } };
  });
  const suggestions = await Promise.all(txns.map(async t => ({
    transaction_id: t.id, category_id: "cat-grocery",
    expected_content_fingerprint: await contentFingerprint(t as ynab.TransactionDetail),
  })));
  const response = await ApplyTool.execute({ planId: "plan-id", suggestions, dry_run: options.dryRun }, api as unknown as ynab.API, { categoryAudit: store });
  return { output: JSON.parse(response.content[0].text), api, store };
}

describe("durable category audit", () => {
  it("persists before-state before mutation and a separate observed outcome", async () => {
    const store = memoryStore();
    const { output } = await auditedCase({ store });
    expect(store.records.map(r => r.phase)).toEqual(["prepared", "outcome"]);
    expect(store.records[0]).toMatchObject({ version: 1, plan_id: "plan-id", dry_run: false,
      rows: [{ status: "pending", expected_content_fingerprint: expect.stringMatching(/^sha256:/) }] });
    expect(store.records[1]).toMatchObject({ rows: [{ status: "applied" }] });
    expect(output).toMatchObject({ success: true, operation_id: store.records[0].operation_id, audit_status: "recorded" });
    expect(JSON.stringify(store.records)).not.toContain("weekly shop");
  });

  it("refuses a live mutation without storage and preserves the undo manifest", async () => {
    const { api, output } = await auditedCase({ missingStore: true });
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
    expect(output).toMatchObject({ success: false, audit_status: "unavailable", undo_manifest: [{ category_id: null }], rows: [{ status: "not_applied" }] });
  });

  it("blocks mutation if the prepared record cannot be persisted", async () => {
    const store = memoryStore();
    store.write = async () => { throw new Error("private storage details"); };
    const { api, output } = await auditedCase({ store });
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
    expect(output).toMatchObject({ success: false, audit_status: "prepare_failed", rows: [{ status: "not_applied" }] });
    expect(JSON.stringify(output)).not.toContain("private storage details");
  });

  it("reports outcome-save failure without hiding the write or losing undo", async () => {
    const store = memoryStore();
    const write = store.write;
    store.write = async record => { if (record.phase === "outcome") throw new Error("disk full"); await write(record); };
    const { output, api } = await auditedCase({ store });
    expect(api.transactions.updateTransactions).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({ success: false, audit_status: "outcome_failed", rows: [{ status: "applied" }], undo_manifest: [{ category_id: null }] });
    expect(store.records).toHaveLength(1);
  });

  it("records API exceptions as unknown outcomes without raw error bodies", async () => {
    const store = memoryStore();
    const { output } = await auditedCase({ store, throws: true });
    expect(output).toMatchObject({ success: false, audit_status: "recorded", rows: [{ status: "unknown", reason: "write_outcome_unknown" }] });
    expect(store.records[1]).toMatchObject({ rows: [{ status: "unknown" }] });
    expect(JSON.stringify([output, store.records])).not.toContain("synthetic credential");
  });

  it("marks omitted or mismatched API responses unknown, including partial batches", async () => {
    const { output } = await auditedCase({
      transactions: [transaction(), transaction({ id: "txn-2" }), transaction({ id: "txn-3" })],
      response: { data: { transactions: [transaction({ category_id: "cat-grocery" }), transaction({ id: "txn-2", category_id: "different" })] } },
    });
    expect(output.success).toBe(false);
    expect(output.rows[1]).toMatchObject({ observed: { category_id: "different", approved: false, deleted: false }, reason: "write_response_mismatch" });
    expect(output.rows[2]).toMatchObject({ reason: "write_not_confirmed" });
    expect(output.rows.map((r: { status: string }) => r.status)).toEqual(["applied", "unknown", "unknown"]);
  });

  it.each([true, false])("records non-writing requests (dry_run=%s)", async dryRun => {
    const store = memoryStore();
    const { output, api } = await auditedCase({ store, dryRun, transactions: [transaction(dryRun ? {} : { category_id: "cat-grocery" })] });
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(2);
    expect(output.rows[0].status).toBe(dryRun ? "would_apply" : "already_applied");
  });

  it("allows dry-run without configured storage", async () => {
    const { output, api } = await auditedCase({ missingStore: true, dryRun: true });
    expect(output).toMatchObject({ success: true, audit_status: "not_configured", rows: [{ status: "would_apply" }] });
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
  });

  it.each([
    [{ transfer_account_id: "other" }, "transfer"],
    [{ subtransactions: [{ deleted: false }] }, "split"],
    [{ category_id: "existing" }, "not_uncategorized"],
    [{ amount: 1000 }, "not_uncategorized"],
  ])("does not mutate excluded transactions %j", async (overrides, reason) => {
    const { output, api } = await auditedCase({ transactions: [transaction(overrides)] });
    expect(output.rows[0]).toMatchObject({ status: "rejected", reason });
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
  });
  it("writes only eligible rows in a mixed batch and audits excluded rows", async () => {
    const store = memoryStore();
    const { output, api } = await auditedCase({ store, transactions: [transaction(), transaction({ id: "txn-2", approved: true })] });
    expect(api.transactions.updateTransactions).toHaveBeenCalledWith("plan-id", { transactions: [{ id: "txn-1", category_id: "cat-grocery" }] });
    expect(output.rows.map((r: { status: string }) => r.status)).toEqual(["applied", "rejected"]);
    expect(store.records[1].rows[1]).toMatchObject({ status: "rejected", reason: "approved" });
  });

  it("rejects unavailable target categories, duplicates and failed refetches", async () => {
    const current = transaction();
    const fingerprint = await contentFingerprint(current as ynab.TransactionDetail);
    const api = makeApi(current);
    const store = memoryStore();
    api.transactions.getTransactionById.mockRejectedValueOnce(new Error("private details"));
    const response = await ApplyTool.execute({ planId: "plan-id", suggestions: [
      { transaction_id: "missing", category_id: "cat-grocery", expected_content_fingerprint: fingerprint },
      { transaction_id: "txn-1", category_id: "hidden-or-deleted", expected_content_fingerprint: fingerprint },
      { transaction_id: "txn-1", category_id: "cat-grocery", expected_content_fingerprint: fingerprint },
    ] }, api as unknown as ynab.API, { categoryAudit: store });
    const output = JSON.parse(response.content[0].text);
    expect(output.rows.map((r: { reason: string }) => r.reason)).toEqual(["refetch_failed", "ineligible_category", "duplicate_transaction_id"]);
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(2);
    expect(JSON.stringify(store.records)).not.toContain("private details");
  });

  it("audits stale conflicts without attempting a write", async () => {
    const api = makeApi(transaction({ memo: "changed" }));
    const store = memoryStore();
    const response = await ApplyTool.execute({ planId: "plan-id", suggestions: [{
      transaction_id: "txn-1", category_id: "cat-grocery", expected_content_fingerprint: await contentFingerprint(transaction() as ynab.TransactionDetail),
    }] }, api as unknown as ynab.API, { categoryAudit: store });
    expect(JSON.parse(response.content[0].text).rows[0]).toMatchObject({ status: "rejected", reason: "fingerprint_mismatch" });
    expect(store.records[1].rows[0].reason).toBe("fingerprint_mismatch");
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
  });

});
