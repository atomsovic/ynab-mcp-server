import { memoryNamespace } from "./helpers/durable.js";
import { OAuthGrantStore, beginGrant, activateGrant } from "../worker/oauth-grants.js";
import { selectedPlan, memoryFlows } from "./helpers/oauth.js";
import { afterEach, describe, it, expect, vi } from "vitest";

import { createServer, McpApiHandler } from "../worker/mcp.js";
import * as ynab from "ynab";
import { contentFingerprint } from "../tools/SuggestCategoriesTool.js";
import { tools } from "../registry.js";
import type { WorkerEnv } from "../worker/env.js";

const env: WorkerEnv = {
  YNAB_API_TOKEN: "test-token",
  YNAB_ALLOWED_PLAN_ID: selectedPlan,
  PUBLIC_ORIGIN: "https://example.com",
  OAUTH_ALLOWED_REDIRECT_URIS: '["https://client.example/callback"]',
  OAUTH_FLOWS: memoryFlows() as unknown as DurableObjectNamespace,
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  ALLOWED_GITHUB_LOGIN: "someone",
};

/** Sends one JSON-RPC message to the Worker's /mcp handler. */
async function call(body: unknown, overrides: Partial<WorkerEnv> = {}) {
  const request = new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const configured = { ...env, OAUTH_GRANTS: memoryNamespace(OAuthGrantStore) as unknown as DurableObjectNamespace, ...overrides };
  const identity = { userId: "123", clientId: "client-1", authorizationId: "a".repeat(64), grantId: "synthetic-grant" };
  await beginGrant(configured, identity, identity.authorizationId);
  await activateGrant(configured, identity, Date.now() + 604800000);
  return McpApiHandler.fetch(request, configured, { props: { version: 2, userId: "123", grantId: "synthetic-grant", authorizationId: "a".repeat(64), login: "someone", clientId: "client-1", redirectUri: "https://client.example/callback", origin: "https://example.com", allowedPlanId: selectedPlan,
    mode: configured.YNAB_READ_ONLY === "true" || configured.YNAB_TOOL_MODE === "read-only" ? "read-only" : configured.YNAB_TOOL_MODE ?? "category-only" } });
}

/** The handler may answer as JSON or as a single SSE frame; accept both. */
async function readResult(response: Response) {
  const text = await response.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

describe("worker MCP handler", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("mirrors plan environment aliases without resolving them", async () => {
    vi.stubEnv("YNAB_PLAN_ID", "original-plan");
    vi.stubEnv("YNAB_BUDGET_ID", "original-budget");

    const legacyOnlyServer = createServer({ ...env, YNAB_BUDGET_ID: selectedPlan });
    expect(process.env.YNAB_PLAN_ID).toBeUndefined();
    expect(process.env.YNAB_BUDGET_ID).toBe(selectedPlan);
    await legacyOnlyServer.close();

    const bothServer = createServer({
      ...env,
      YNAB_PLAN_ID: selectedPlan,
      YNAB_BUDGET_ID: selectedPlan,
    });
    expect(process.env.YNAB_PLAN_ID).toBe(selectedPlan);
    expect(process.env.YNAB_BUDGET_ID).toBe(selectedPlan);
    await bothServer.close();
  });

  it("responds to initialize over HTTP", async () => {
    const response = await call(initialize);
    expect(response.status).toBe(200);

    const result = await readResult(response);
    expect(result.result.serverInfo).toEqual({
      name: "ynab-mcp-server",
      version: "0.4.0",
    });
  });

  it("serves reads and only audited category writes by default", async () => {
    const response = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const result = await readResult(response);

    const names = result.result.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(tools.filter((tool) => !tool.requiresAiCategorization && (!tool.writes || tool.module.name === "ynab_apply_category_suggestions")).length);
    expect(names).toContain("ynab_budget_summary");
    expect(names).not.toContain("ynab_create_transaction");
    expect(names).toContain("ynab_apply_category_suggestions");
    expect(names).not.toContain("ynab_suggest_categories");
  });

  it("exposes category suggestions only with both opt-in settings", async () => {
    const onlyFlag = await call(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { YNAB_AI_CATEGORIZATION: "true" },
    );
    const onlyFlagResult = await readResult(onlyFlag);
    expect(onlyFlagResult.result.tools.map((t: { name: string }) => t.name)).not.toContain("ynab_suggest_categories");

    const enabled = await call(
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      { YNAB_AI_CATEGORIZATION: "true", TYPESAFE_API_KEY: "typesafe-secret", YNAB_READ_ONLY: "true" },
    );
    const enabledResult = await readResult(enabled);
    const names = enabledResult.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("ynab_suggest_categories");
    expect(names).not.toContain("ynab_create_transaction");
  });

  it("hides write tools when YNAB_READ_ONLY is true", async () => {
    const response = await call(
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      { YNAB_READ_ONLY: "true" },
    );
    const result = await readResult(response);

    const names = result.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("ynab_budget_summary");
    expect(names).not.toContain("ynab_create_transaction");
    expect(names).not.toContain("ynab_delete_transaction");
  });
  it("refuses direct write-tool calls in read-only mode without fetching", async () => {
    const fetch = vi.fn(() => { throw new Error("No network in this test"); });
    vi.stubGlobal("fetch", fetch);
    const response = await call({ jsonrpc: "2.0", id: 10, method: "tools/call", params: {
      name: "ynab_apply_category_suggestions", arguments: { planId: selectedPlan, suggestions: [] },
    } }, { YNAB_READ_ONLY: "true" });
    const result = await readResult(response);
    expect(result.error || result.result?.isError).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("wires R2 through application and retrieves the audit in a new read-only server", async () => {
    const objects = new Map<string, string>();
    const bucket = {
      async put(key: string, body: string) { objects.set(key, body); return { key }; },
      async get(key: string) { return objects.has(key) ? { text: async () => objects.get(key)! } : null; },
    };
    const transaction = { id: "txn-1", amount: -1000, approved: false, cleared: "uncleared", deleted: false,
      category_id: null, subtransactions: [], account_id: "a", date: "2026-10-01" };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        expect(objects.size).toBe(1);
        expect(JSON.parse([...objects.values()][0])).toMatchObject({ phase: "prepared", undo_manifest: [{ category_id: null, approved: false }] });
        return Response.json({ data: { transactions: [{ ...transaction, category_id: "category" }] } });
      }
      if (url.endsWith("/categories")) return Response.json({ data: { category_groups: [
        { id: "group", name: "Everyday", hidden: false, deleted: false, categories: [
          { id: "category", name: "Groceries", hidden: false, deleted: false, category_group_id: "group" },
        ] },
      ] } });
      if (url.endsWith("/transactions/txn-1")) return Response.json({ data: { transaction } });
      throw new Error("Unexpected network request");
    });
    vi.stubGlobal("fetch", fetch);
    const response = await call({ jsonrpc: "2.0", id: 11, method: "tools/call", params: {
      name: "ynab_apply_category_suggestions", arguments: { planId: selectedPlan, suggestions: [{
        transaction_id: "txn-1", category_id: "category",
        expected_content_fingerprint: await contentFingerprint(transaction as ynab.TransactionDetail),
      }] },
    } }, { CATEGORY_AUDIT: bucket });
    const rpc = await readResult(response);
    const applied = JSON.parse(rpc.result.content[0].text);
    expect(applied).toMatchObject({ success: true, audit_status: "recorded", rows: [{ status: "applied" }] });
    expect(objects.size).toBe(2);
    fetch.mockClear();
    const audit = await call({ jsonrpc: "2.0", id: 12, method: "tools/call", params: {
      name: "ynab_get_category_audit", arguments: { operation_id: applied.operation_id },
    } }, { CATEGORY_AUDIT: bucket, YNAB_READ_ONLY: "true" });
    const retrieved = await readResult(audit);
    expect(JSON.parse(retrieved.result.content[0].text)).toMatchObject({ success: true, status: "recorded", outcome: { rows: [{ status: "applied" }] } });
    expect(fetch).not.toHaveBeenCalled();
  });

});
