import type * as ynab from "ynab";
import type { PlanStaging, StagedReview, StagingSnapshot } from "./types.js";

export const STAGED_READ_TOOLS = new Set([
  "ynab_suggest_categories", "ynab_get_transactions", "ynab_get_unapproved_transactions",
  "ynab_list_accounts", "ynab_list_payees", "ynab_list_categories",
  "ynab_spending_by_payee", "ynab_spending_by_category",
]);

/** An immutable per-invocation view. Never use this adapter for application. */
export function snapshotApi(_live: ynab.API, snapshot: StagingSnapshot, planId: string): ynab.API {
  const check = (id: string) => { if (id !== planId) throw new Error("Requested plan is not allowed"); };
  const list = async (id: string, since?: string, until?: string, type?: string, filter: (row: ynab.TransactionDetail) => boolean = () => true) => {
    check(id);
    if (since && since < snapshot.history_since) throw new Error("Requested date is outside retained staging history");
    return { data: { server_knowledge: snapshot.server_knowledge.transactions, transactions: structuredClone(snapshot.transactions.filter(row =>
      (!since || row.date >= since) && (!until || row.date <= until) &&
      (type !== "unapproved" || !row.approved) && (type !== "uncategorized" || !row.category_id) && filter(row))) } };
  };
  const hybridList = async (id: string, key: string, field: "category_id" | "payee_id", since?: string, until?: string, type?: string) => {
    const base = await list(id, since, until, undefined);
    const candidates = base.data.transactions.flatMap<ynab.TransactionDetail & { type: string; parent_transaction_id: string | null }>(row => {
      const subtransactions = (row.subtransactions ?? []).filter(sub => !sub.deleted);
      if (subtransactions.length) return subtransactions.map(sub => ({ ...row, ...sub,
        date: row.date, approved: row.approved, cleared: row.cleared, account_id: row.account_id,
        account_name: row.account_name, type: "subtransaction", parent_transaction_id: row.id, subtransactions: [],
      }));
      return [{ ...row, type: "transaction", parent_transaction_id: null }];
    });
    return { data: { transactions: candidates.filter(row => row[field] === key &&
      (type !== "unapproved" || !row.approved) && (type !== "uncategorized" || !row.category_id)) } };
  };
  const deny = async () => { throw new Error("Staging adapter is read-only; live API is required for this operation"); };
  const transactions = new Proxy({
    getTransactions: list,
    getTransactionsByAccount: (id: string, key: string, since?: string, until?: string, type?: string) => list(id, since, until, type, row => row.account_id === key),
    getTransactionsByCategory: (id: string, key: string, since?: string, until?: string, type?: string) => hybridList(id, key, "category_id", since, until, type),
    getTransactionsByPayee: (id: string, key: string, since?: string, until?: string, type?: string) => hybridList(id, key, "payee_id", since, until, type),
    getTransactionById: async (id: string, key: string) => {
      check(id); const transaction = snapshot.transactions.find(row => row.id === key);
      if (!transaction) throw new Error("Transaction is outside the retained staging snapshot");
      return { data: { transaction: structuredClone(transaction) } };
    },
  }, { get(target, key) { return key in target ? Reflect.get(target, key) : deny; } });
  return {
    transactions,
    categories: { getCategories: async (id: string) => { check(id); return { data: { category_groups: structuredClone(snapshot.category_groups) } }; } },
    payees: { getPayees: async (id: string) => { check(id); return { data: { payees: structuredClone(snapshot.payees) } }; } },
    accounts: { getAccounts: async (id: string) => { check(id); return { data: { accounts: structuredClone(snapshot.accounts) } }; } },
  } as unknown as ynab.API;
}

export function attachStagingMetadata(result: any, snapshot: StagingSnapshot, source = "snapshot") {
  if (!result?.content?.[0]?.text) return result;
  const body = JSON.parse(result.content[0].text);
  body.staging = { source, revision: source === "snapshot" ? snapshot.revision : null,
    synced_at: snapshot.synced_at, history_since: snapshot.history_since,
    stale: Date.now() - Date.parse(snapshot.synced_at) > 300_000,
    consistency: source === "snapshot" ? "committed_local_revision; upstream endpoints are not transactional" : "live_read; not a staged revision" };
  return { ...result, content: [{ ...result.content[0], text: JSON.stringify(body, null, 2) }, ...result.content.slice(1)] };
}

export async function persistSuggestionReviews(staging: PlanStaging, snapshot: StagingSnapshot, result: any) {
  const body = JSON.parse(result.content[0].text);
  if (!body.success || !Array.isArray(body.transactions)) return result;
  const permitted = new Set(["suggested", "needs_review", "uncertain", "left_uncategorized"]);
  const rows: StagedReview[] = body.transactions.filter((row: any) => permitted.has(row.status) &&
    typeof row.content_fingerprint === "string").map((row: any) => ({
      transaction_id: row.transaction_id, content_fingerprint: row.content_fingerprint,
      snapshot_revision: snapshot.revision,
      proposed_category: row.proposed_category ? { id: row.proposed_category.id, name: row.proposed_category.name, group_name: row.proposed_category.group_name } : null,
      status: row.status, model_confidence: row.model_confidence, winning_probability: row.winning_probability,
      evidence: `Source: ${row.source === "jev" ? "TypeSafe" : "transaction history"}; history sample: ${Number.isInteger(row.history?.sample_size) ? row.history.sample_size : 0}; category confidence is provisional.`,
      questions: row.status === "needs_review" || row.status === "uncertain" ? ["Confirm the merchant and intended category before any change."] : [],
      decision: "pending", note: "", updated_at: new Date().toISOString(),
    }));
  try {
    if (rows.length) await staging.saveReviews(snapshot.revision, rows);
    body.review_persistence = { saved: true, count: rows.length };
  } catch {
    body.review_persistence = { saved: false, error: "Review queue persistence failed or snapshot changed; refresh before relying on saved proposals." };
  }
  return { ...result, content: [{ ...result.content[0], text: JSON.stringify(body, null, 2) }, ...result.content.slice(1)] };
}
