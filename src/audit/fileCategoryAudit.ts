import { open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { auditFilename, type AuditPhase, type CategoryAuditRecord, type CategoryAuditStore } from "./categoryAudit.js";

/** Requires an existing private directory on a persistent filesystem supporting fsync. */
export class FileCategoryAuditStore implements CategoryAuditStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }

  async write(record: CategoryAuditRecord): Promise<void> {
    const path = join(this.directory, auditFilename(record.operation_id, record.phase));
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(record) + "\n", "utf8");
      await file.sync();
    } finally { await file.close(); }
    // Persist the new directory entry too. Never acknowledge a write if this fails.
    const directory = await open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async read(operationId: string, phase: AuditPhase): Promise<CategoryAuditRecord | null> {
    const path = join(this.directory, auditFilename(operationId, phase));
    try { return JSON.parse(await readFile(path, "utf8")) as CategoryAuditRecord; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
