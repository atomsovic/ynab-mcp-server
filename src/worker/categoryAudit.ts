import { auditFilename, type AuditPhase, type CategoryAuditRecord, type CategoryAuditStore } from "../audit/categoryAudit.js";

/** Structural binding surface also usable by synthetic test buckets. */
export interface AuditBucket {
  put(key: string, value: string, options: { onlyIf: { etagDoesNotMatch: string } }): Promise<unknown | null>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export class R2CategoryAuditStore implements CategoryAuditStore {
  constructor(private readonly bucket: AuditBucket) {}
  async write(record: CategoryAuditRecord): Promise<void> {
    const key = `category-audit/v1/${auditFilename(record.operation_id, record.phase)}`;
    const stored = await this.bucket.put(key, JSON.stringify(record), { onlyIf: { etagDoesNotMatch: "*" } });
    if (!stored) throw new Error("Audit record was not stored");
  }
  async read(operationId: string, phase: AuditPhase): Promise<CategoryAuditRecord | null> {
    const object = await this.bucket.get(`category-audit/v1/${auditFilename(operationId, phase)}`);
    return object ? JSON.parse(await object.text()) as CategoryAuditRecord : null;
  }
}
