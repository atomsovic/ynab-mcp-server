import type * as ynab from "ynab";

export interface StagingScope { userId: string; planId: string }
export interface StagingSnapshot {
  revision: number;
  synced_at: string;
  history_since: string;
  server_knowledge: Record<"transactions" | "accounts" | "payees" | "categories", number>;
  transactions: ynab.TransactionDetail[];
  accounts: ynab.Account[];
  payees: ynab.Payee[];
  category_groups: ynab.CategoryGroupWithCategories[];
}
export interface StagingStatus {
  revision: number;
  synced_at: string | null;
  history_since: string | null;
  stale: boolean;
  retry_after: string | null;
  last_error: string | null;
  rate: { used: number; limit: number; window_started_at: string };
}
export interface StagedReview {
  transaction_id: string;
  content_fingerprint: string;
  snapshot_revision: number;
  proposed_category: { id: string; name: string; group_name: string } | null;
  status: string;
  model_confidence: number | null;
  winning_probability: number | null;
  evidence: string;
  questions: string[];
  decision: "pending" | "reviewed" | "dismissed" | "stale";
  note: string;
  updated_at: string;
}
/** Durable staging never authorizes YNAB writes. Review decisions are advisory. */
export interface PlanStaging {
  snapshot(): Promise<StagingSnapshot>;
  sync(): Promise<StagingSnapshot>;
  status(): Promise<StagingStatus>;
  saveReviews(revision: number, rows: StagedReview[]): Promise<void>;
  reviews(): Promise<StagedReview[]>;
  updateReview(transactionId: string, decision: "pending" | "reviewed" | "dismissed", note: string, questions: string[]): Promise<void>;
  clear(): Promise<void>;
}
