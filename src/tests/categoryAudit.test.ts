import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as ApplyTool from "../tools/ApplyCategorySuggestionsTool.js";
import { contentFingerprint } from "../tools/SuggestCategoriesTool.js";
import type * as ynab from "ynab";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCategoryAuditStore } from "../audit/fileCategoryAudit.js";
import { R2CategoryAuditStore } from "../worker/categoryAudit.js";
import type { CategoryAuditRecord } from "../audit/categoryAudit.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const id = "00000000-0000-4000-8000-000000000001";
const record: CategoryAuditRecord = { version: 1, operation_id: id, phase: "prepared", recorded_at: "2026-10-03T00:00:00.000Z", plan_id: "synthetic-plan", dry_run: false, undo_manifest: [], rows: [] };
const directories: string[] = [];
afterEach(async () => { vi.mocked(fs.open).mockReset(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("file category audit", () => {
  it("survives a new store instance and keeps phases separate and private", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ynab-audit-")); directories.push(dir);
    await new FileCategoryAuditStore(dir).write(record);
    const restarted = new FileCategoryAuditStore(dir);
    expect(await restarted.read(id, "prepared")).toEqual(record);
    expect(await restarted.read(id, "outcome")).toBeNull();
    await restarted.write({ ...record, phase: "outcome" });
    expect(await new FileCategoryAuditStore(dir).read(id, "outcome")).toEqual({ ...record, phase: "outcome" });
    expect((await stat(join(dir, `${id}.prepared.json`))).mode & 0o777).toBe(0o600);
    await expect(restarted.write({ ...record, plan_id: "overwrite" })).rejects.toThrow();
    expect(await restarted.read(id, "prepared")).toEqual(record);
  });
  it("rejects path traversal and fails when the configured directory is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ynab-audit-")); directories.push(dir);
    const store = new FileCategoryAuditStore(dir);
    await expect(store.read("../secret", "prepared")).rejects.toThrow();
    await expect(new FileCategoryAuditStore(join(dir, "missing")).write(record)).rejects.toThrow();
  });
  it.each(["file", "directory"])("blocks YNAB writes when %s sync fails", async failAt => {
    const events: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (_path, flags) => {
      const target = flags === "wx" ? "file" : "directory";
      events.push(`open:${target}`);
      return {
        async writeFile() { events.push("write"); },
        async sync() { events.push(`sync:${target}`); if (target === failAt) throw new Error("sync failed"); },
        async close() { events.push(`close:${target}`); },
      } as unknown as Awaited<ReturnType<typeof fs.open>>;
    });
    const transaction = { id: "txn", amount: -1000, approved: false, deleted: false,
      cleared: "uncleared", category_id: null, subtransactions: [] } as unknown as ynab.TransactionDetail;
    const api = {
      categories: { getCategories: async () => ({ data: { category_groups: [{
        id: "g", name: "Everyday", categories: [{ id: "c", name: "Groceries" }],
      }] } }) },
      transactions: { getTransactionById: async () => ({ data: { transaction } }), updateTransactions: vi.fn() },
    };
    const response = await ApplyTool.execute({ planId: "synthetic", suggestions: [{
      transaction_id: "txn", category_id: "c", expected_content_fingerprint: await contentFingerprint(transaction),
    }] }, api as unknown as ynab.API, { categoryAudit: new FileCategoryAuditStore("/synthetic") });
    expect(JSON.parse(response.content[0].text)).toMatchObject({ success: false, audit_status: "prepare_failed" });
    expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
    expect(events).toEqual(failAt === "file"
      ? ["open:file", "write", "sync:file", "close:file"]
      : ["open:file", "write", "sync:file", "close:file", "open:directory", "sync:directory", "close:directory"]);
  });

});

describe("R2 category audit", () => {
  function bucket() {
    const objects = new Map<string, string>();
    return {
      objects,
      async put(key: string, value: string, options: { onlyIf: { etagDoesNotMatch: string } }) {
        expect(options.onlyIf.etagDoesNotMatch).toBe("*");
        if (objects.has(key)) return null;
        objects.set(key, value); return { key };
      },
      async get(key: string) { const value = objects.get(key); return value ? { text: async () => value } : null; },
    };
  }
  it("persists across Worker store instances and refuses overwrites", async () => {
    const storage = bucket();
    await new R2CategoryAuditStore(storage).write(record);
    const restarted = new R2CategoryAuditStore(storage);
    expect(await restarted.read(id, "prepared")).toEqual(record);
    expect(await restarted.read(id, "outcome")).toBeNull();
    await expect(restarted.write({ ...record, plan_id: "overwrite" })).rejects.toThrow();
    expect(await restarted.read(id, "prepared")).toEqual(record);
  });
  it("propagates storage failure and rejects malformed operation IDs", async () => {
    const storage = bucket();
    storage.put = async () => { throw new Error("unavailable"); };
    const store = new R2CategoryAuditStore(storage);
    await expect(store.write(record)).rejects.toThrow("unavailable");
    await expect(store.read("../secret", "prepared")).rejects.toThrow();
  });
});
