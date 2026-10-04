import type { PlanStaging } from "../staging/types.js";
/** Minimal state required to review and manually reverse a category-only change. */
export interface CategoryUndo {
  transaction_id: string;
  category_id: string | null;
  approved: boolean;
  requested_category_id: string;
}

export interface CategoryAuditRow {
  transaction_id: string;
  category_id: string;
  expected_content_fingerprint: string;
  status: "rejected" | "already_applied" | "would_apply" | "pending" | "not_applied" | "applied" | "unknown";
  reason?: string;
  current_content_fingerprint?: string;
  observed?: { category_id: string | null; approved: boolean; deleted: boolean };
  undo?: { transaction_id: string; category_id: string | null; approved: boolean };
}

export type AuditPhase = "prepared" | "outcome";
export interface CategoryAuditRecord {
  version: 1;
  operation_id: string;
  phase: AuditPhase;
  recorded_at: string;
  plan_id: string;
  dry_run: boolean;
  undo_manifest: CategoryUndo[];
  rows: CategoryAuditRow[];
}

/** write must durably acknowledge the record or reject; records are immutable. */
export interface CategoryAuditStore {
  write(record: CategoryAuditRecord): Promise<void>;
  read(operationId: string, phase: AuditPhase): Promise<CategoryAuditRecord | null>;
}
export interface ToolContext { categoryAudit?: CategoryAuditStore; allowedPlanId?: string; staging?: PlanStaging }

export function auditFilename(operationId: string, phase: AuditPhase): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId) ||
      (phase !== "prepared" && phase !== "outcome")) throw new Error("Invalid audit record identifier");
  return `${operationId}.${phase}.json`;
}
