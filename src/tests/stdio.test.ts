import { afterEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCategoryAuditStore } from "../audit/fileCategoryAudit.js";

const { names, callbacks } = vi.hoisted(() => ({ names: [] as string[], callbacks: new Map<string, (input: unknown) => Promise<any>>() }));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(name: string, _config: unknown, callback: (input: unknown) => Promise<any>) { names.push(name); callbacks.set(name, callback); }
    async connect() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("ynab", () => ({ API: class {} }));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("stdio entry point", () => {
  it.each(["true", "false", undefined])("honors YNAB_READ_ONLY=%s", async (value) => {
    vi.resetModules();
    names.length = 0;
    callbacks.clear();
    vi.stubEnv("YNAB_CATEGORY_AUDIT_DIR", undefined);
    vi.stubEnv("YNAB_API_TOKEN", "synthetic-token");
    vi.stubEnv("YNAB_READ_ONLY", value);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../index.js");
    const { tools } = await import("../registry.js");
    expect(names).toContain("ynab_list_plans");
    for (const tool of tools.filter(t => t.writes)) {
      expect(names.includes(tool.module.name), tool.module.name).toBe(value !== "true");
    }
  });
  it("wires the persistent directory into registered audit lookup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ynab-stdio-audit-"));
    try {
      const operationId = "00000000-0000-4000-8000-000000000001";
      await new FileCategoryAuditStore(directory).write({
        version: 1, operation_id: operationId, phase: "prepared", recorded_at: "2026-10-03T00:00:00Z",
        plan_id: "synthetic", dry_run: false, undo_manifest: [], rows: [],
      });
      vi.resetModules();
      vi.stubEnv("YNAB_API_TOKEN", "synthetic-token");
      vi.stubEnv("YNAB_READ_ONLY", "true");
      vi.stubEnv("YNAB_CATEGORY_AUDIT_DIR", directory);
      vi.spyOn(console, "error").mockImplementation(() => {});
      await import("../index.js");
      const result = await callbacks.get("ynab_get_category_audit")!({ operation_id: operationId });
      expect(JSON.parse(result.content[0].text)).toMatchObject({ success: true, status: "needs_reconciliation", prepared: { plan_id: "synthetic" } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

});
