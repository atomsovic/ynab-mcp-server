import type * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";

export const MAX_MISSING_ID_FALLBACKS = 10;

export interface ExplicitCategoryCandidates {
  transactions: ynab.TransactionDetail[];
  failures: { transactionId: string; error: string }[];
}

/**
 * An unfiltered collection includes older requested rows but excludes pending
 * transactions in YNAB. Resolve absent IDs individually, with a hard request
 * bound: at most 11 candidate requests + 4 prerequisites + 10 TypeSafe batches.
 * This cache lasts for one invocation only. A single ID keeps its original
 * individual endpoint semantics and avoids downloading the whole plan.
 */
export async function loadExplicitCategoryCandidates(
  api: ynab.API,
  planId: string,
  transactionIds: string[],
): Promise<ExplicitCategoryCandidates> {
  const ids = [...new Set(transactionIds)];
  const transactions: ynab.TransactionDetail[] = [];
  const failures: ExplicitCategoryCandidates["failures"] = [];
  if (ids.length === 0) return { transactions, failures };

  const byId = new Map<string, ynab.TransactionDetail>();
  if (ids.length > 1) {
    try {
      const response = await api.transactions.getTransactions(planId);
      for (const transaction of response.data.transactions) byId.set(transaction.id, transaction);
    } catch (error) {
      // A failed collection must not become N individual requests.
      return { transactions, failures: ids.map((transactionId) => ({
        transactionId, error: `Bulk transaction request failed: ${getErrorMessage(error)}`,
      })) };
    }
  }

  let individualRequests = 0;
  for (const transactionId of ids) {
    let transaction = byId.get(transactionId);
    if (!transaction) {
      if (individualRequests >= MAX_MISSING_ID_FALLBACKS) {
        failures.push({ transactionId, error: "Transaction absent from the collection (possibly pending); individual lookup budget exhausted. Retry this ID alone or in a group of at most 10 IDs." });
        continue;
      }
      individualRequests++;
      try {
        transaction = (await api.transactions.getTransactionById(planId, transactionId)).data.transaction;
      } catch (error) {
        failures.push({ transactionId, error: getErrorMessage(error) });
        continue;
      }
    }
    if (!transaction.deleted) transactions.push(transaction);
  }
  return { transactions, failures };
}
