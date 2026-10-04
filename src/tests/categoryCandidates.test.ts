import { afterEach, describe, expect, it, vi } from "vitest";
import * as ynab from "ynab";
import * as Tool from "../tools/SuggestCategoriesTool.js";
import { loadExplicitCategoryCandidates, MAX_MISSING_ID_FALLBACKS } from "../tools/categoryCandidates.js";

function transaction(id: string, overrides: Record<string, unknown> = {}) {
  return { id, date: "2026-09-12", amount: -12500, memo: null, cleared: "cleared",
    approved: false, account_id: "account", account_name: "Checking", payee_id: "payee",
    payee_name: "Merchant", category_id: null, category_name: null,
    transfer_account_id: null, subtransactions: [], deleted: false, ...overrides };
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("category candidate bulk reads", () => {
  it.each([98, 100])("previews %i explicit IDs through the real SDK under a 50-subrequest cap", async (count) => {
    vi.stubEnv("YNAB_AI_CATEGORIZATION", "true");
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-test-key");
    const rows = Array.from({ length: count }, (_, index) => transaction(`txn-${index}`));
    let requestCount = 0;
    let providerCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (++requestCount > 50) throw new Error("synthetic Worker subrequest limit exceeded");
      const url = new URL(String(input));
      if (url.hostname === "api.typesafe.ai") {
        providerCalls++;
        const body = JSON.parse(String(init?.body));
        const answers = Object.fromEntries(Object.keys(body.questions).map((key) => [key, {
          type: "choice", choice: "c000", confidence: 0.9,
          probabilities: { c000: 0.9, leave_uncategorized: 0.1 },
        }]));
        return Response.json({ model: Tool.PINNED_MODEL, answers, usage: { input_tokens: 100, output_tokens: 10 } });
      }
      expect(init?.method).toBe("GET");
      const tail = url.pathname.split("/").at(-1);
      if (tail === "transactions") return Response.json({ data: { transactions: url.searchParams.has("since_date") ? [] : rows, server_knowledge: 1 } });
      if (tail?.startsWith("txn-")) return Response.json({ data: { transaction: rows.find((row) => row.id === tail) } });
      if (tail === "categories") return Response.json({ data: { category_groups: [{ id: "group", name: "Everyday", hidden: false, deleted: false,
        categories: [{ id: "cat", name: "Groceries", category_group_id: "group", hidden: false, deleted: false }] }] } });
      if (tail === "payees") return Response.json({ data: { payees: [{ id: "payee", name: "Merchant", deleted: false }] } });
      if (tail === "accounts") return Response.json({ data: { accounts: [{ id: "account", name: "Checking", type: "checking", on_budget: true, deleted: false }] } });
      throw new Error(`Unexpected synthetic route ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const output = await Tool.execute({ planId: "synthetic-plan", transactionIds: rows.map((row) => row.id) }, new ynab.API("synthetic-token"));
    const result = JSON.parse(output.content[0].text);
    expect(result.transactions).toHaveLength(count);
    expect(result.transactions.every((row: { status: string }) => row.status === "suggested")).toBe(true);
    expect(providerCalls).toBe(10);
    expect(requestCount).toBe(15);
  });
});

function candidateApi(collection: ReturnType<typeof transaction>[], individual = collection) {
  return {
    transactions: {
      getTransactions: vi.fn().mockResolvedValue({ data: { transactions: collection } }),
      getTransactionById: vi.fn(async (_planId: string, id: string) => {
        const row = individual.find((item) => item.id === id);
        if (!row) throw { error: { id: "404", name: "not_found", detail: "Transaction not found" } };
        return { data: { transaction: row } };
      }),
    },
  };
}

describe("explicit category selection semantics", () => {
  it("indexes the full collection, preserves requested order and deduplicates IDs", async () => {
    const old = transaction("old", { date: "2001-01-01" });
    const current = transaction("current");
    const api = candidateApi([current, transaction("unrequested"), old]);
    const result = await loadExplicitCategoryCandidates(api as unknown as ynab.API, "selected-plan", ["old", "current", "old"]);
    expect(result).toEqual({ transactions: [old, current], failures: [] });
    expect(api.transactions.getTransactions).toHaveBeenCalledExactlyOnceWith("selected-plan");
    expect(api.transactions.getTransactionById).not.toHaveBeenCalled();
  });

  it("fetches pending IDs missing from the collection without changing selection order", async () => {
    const posted = transaction("posted");
    const pending = transaction("pending", { cleared: "uncleared" });
    const api = candidateApi([posted], [posted, pending]);
    const result = await loadExplicitCategoryCandidates(api as unknown as ynab.API, "plan", ["pending", "posted"]);
    expect(result).toEqual({ transactions: [pending, posted], failures: [] });
    expect(api.transactions.getTransactionById).toHaveBeenCalledExactlyOnceWith("plan", "pending");
  });

  it("omits deleted rows from both collection and individual responses", async () => {
    const deleted = transaction("deleted", { deleted: true });
    const absentDeleted = transaction("absent-deleted", { deleted: true });
    const posted = transaction("posted");
    const api = candidateApi([deleted, posted], [absentDeleted]);
    const result = await loadExplicitCategoryCandidates(api as unknown as ynab.API, "plan", ["deleted", "absent-deleted", "posted"]);
    expect(result).toEqual({ transactions: [posted], failures: [] });
    expect(api.transactions.getTransactionById).toHaveBeenCalledExactlyOnceWith("plan", "absent-deleted");
  });

  it("retains single-ID individual semantics after deduplication", async () => {
    const pending = transaction("pending");
    const api = candidateApi([], [pending]);
    expect(await loadExplicitCategoryCandidates(api as unknown as ynab.API, "plan", ["pending", "pending"]))
      .toEqual({ transactions: [pending], failures: [] });
    expect(api.transactions.getTransactions).not.toHaveBeenCalled();
    expect(api.transactions.getTransactionById).toHaveBeenCalledTimes(1);
  });

  it("reports missing IDs while retaining successful siblings", async () => {
    const posted = transaction("posted");
    const api = candidateApi([posted]);
    expect(await loadExplicitCategoryCandidates(api as unknown as ynab.API, "plan", ["missing", "posted"]))
      .toEqual({ transactions: [posted], failures: [{ transactionId: "missing", error: "Transaction not found" }] });
  });

  it("caps missing-ID reads and reports every excess ID with an actionable retry", async () => {
    const pending = Array.from({ length: 98 }, (_, index) => transaction(`pending-${index}`));
    const api = candidateApi([], pending);
    const result = await loadExplicitCategoryCandidates(api as unknown as ynab.API, "plan", pending.map((row) => row.id));
    expect(result.transactions).toEqual(pending.slice(0, MAX_MISSING_ID_FALLBACKS));
    expect(result.failures.map((row) => row.transactionId)).toEqual(pending.slice(MAX_MISSING_ID_FALLBACKS).map((row) => row.id));
    expect(result.failures.every((row) => row.error.includes("Retry this ID alone"))).toBe(true);
    expect(api.transactions.getTransactionById).toHaveBeenCalledTimes(10);
  });

  it("does not turn a failed collection into many individual requests", async () => {
    const api = candidateApi([]);
    api.transactions.getTransactions.mockRejectedValue(new Error("synthetic outage"));
    expect(await loadExplicitCategoryCandidates(api as unknown as ynab.API, "plan", ["one", "two"]))
      .toEqual({ transactions: [], failures: [
        { transactionId: "one", error: "Bulk transaction request failed: synthetic outage" },
        { transactionId: "two", error: "Bulk transaction request failed: synthetic outage" },
      ] });
    expect(api.transactions.getTransactionById).not.toHaveBeenCalled();
  });

  it("does not retain a stale collection across invocations or plans", async () => {
    const api = candidateApi([transaction("one"), transaction("two")]);
    await loadExplicitCategoryCandidates(api as unknown as ynab.API, "plan-a", ["one", "two"]);
    const fresh = transaction("one", { amount: -4500 });
    api.transactions.getTransactions.mockResolvedValue({ data: { transactions: [fresh, transaction("two")] } });
    const result = await loadExplicitCategoryCandidates(api as unknown as ynab.API, "plan-b", ["one", "two"]);
    expect(result.transactions[0]).toEqual(fresh);
    expect(api.transactions.getTransactions.mock.calls).toEqual([["plan-a"], ["plan-b"]]);
  });
});
