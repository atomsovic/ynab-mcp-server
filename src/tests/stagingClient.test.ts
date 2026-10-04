import { describe, expect, it, vi } from "vitest";
import { DurablePlanStaging } from "../worker/staging-client.js";
import type { StagedReview } from "../staging/types.js";

const scope = { userId: "123456", planId: "joint-plan-synthetic" };
const sensitive = "SYNTHETIC_SECRET_DO_NOT_EXPOSE financial memo";

function fixture() {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => Response.json({}));
  const namespace = {
    idFromName: vi.fn((name: string) => ({ name })),
    get: vi.fn((_id: unknown) => ({ fetch })),
  };
  const create = (selectedScope = scope) => new DurablePlanStaging(namespace as unknown as DurableObjectNamespace, selectedScope);
  return { namespace, fetch, create };
}

describe("private staging client", () => {
  it("selects a stable namespace identity containing both principal and plan", () => {
    const f = fixture();
    f.create();
    f.create({ ...scope });
    f.create({ ...scope, userId: "654321" });
    f.create({ ...scope, planId: "other-plan" });
    const names = f.namespace.idFromName.mock.calls.map(([name]) => name);
    expect(names).toEqual([
      JSON.stringify([scope.userId, scope.planId]),
      JSON.stringify([scope.userId, scope.planId]),
      JSON.stringify(["654321", scope.planId]),
      JSON.stringify([scope.userId, "other-plan"]),
    ]);
    expect(new Set(names).size).toBe(3);
    expect(f.namespace.get.mock.calls.map(([id]) => id)).toEqual(names.map((name) => ({ name })));
  });

  it("avoids delimiter collisions between principal and plan identities", () => {
    const f = fixture();
    f.create({ userId: "a:b", planId: "c" });
    f.create({ userId: "a", planId: "b:c" });
    expect(f.namespace.idFromName.mock.calls[0][0]).not.toBe(f.namespace.idFromName.mock.calls[1][0]);
  });

  it("sends selected scope on every internal operation without credentials", async () => {
    const f = fixture();
    const client = f.create();
    const rows: StagedReview[] = [{
      transaction_id: "transaction", content_fingerprint: "sha256:synthetic", snapshot_revision: 7,
      proposed_category: { id: "category", name: "Groceries", group_name: "Everyday" },
      status: "suggested", model_confidence: 0.9, winning_probability: 0.91,
      evidence: "Synthetic matching history", questions: [], decision: "pending", note: "",
      updated_at: "2026-10-04T00:00:00.000Z",
    }];
    await client.snapshot();
    await client.sync();
    await client.status();
    await client.saveReviews(7, rows);
    await client.reviews();
    await client.updateReview("transaction", "reviewed", "Checked receipt", ["Which merchant?"]);
    await client.clear();
    const expected = [
      ["/snapshot", {}], ["/sync", {}], ["/status", {}],
      ["/reviews/save", { revision: 7, rows }], ["/reviews/list", {}],
      ["/reviews/update", { transactionId: "transaction", decision: "reviewed", note: "Checked receipt", questions: ["Which merchant?"] }],
      ["/clear", {}],
    ];
    expect(f.fetch.mock.calls).toHaveLength(expected.length);
    for (const [index, [url, init]] of f.fetch.mock.calls.entries()) {
      const [path, payload] = expected[index];
      expect(url).toBe(`https://staging.internal${path}`);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual({ scope, ...payload as object });
    }
  });

  it("returns successful response data through the internal client", async () => {
    const f = fixture();
    const data = { revision: 7, synced_at: "2026-10-04T00:00:00.000Z", stale: false };
    f.fetch.mockResolvedValue(Response.json(data));
    expect(await f.create().status()).toEqual(data);
  });

  it("sanitizes thrown transport failures", async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error(sensitive));
    await expect(f.create().snapshot()).rejects.toThrow(/^Private staging is temporarily unavailable$/);
  });

  it("sanitizes malformed success JSON without exposing response-body snippets", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response(sensitive, { status: 200 }));
    await expect(f.create().snapshot()).rejects.toThrow(/^Private staging returned an invalid response$/);
  });

  it.each([
    [429, "Private staging sync is cooling down; inspect staging status before retrying"],
    [409, "Staging snapshot changed; refresh and review again"],
    [400, "Private staging operation failed"],
    [401, "Private staging operation failed"],
    [500, "Private staging operation failed"],
    [503, "Private staging operation failed"],
  ])("sanitizes HTTP %i without reading upstream bodies", async (status, message) => {
    const f = fixture();
    const response = new Response(JSON.stringify({ error: sensitive }), { status });
    const json = vi.spyOn(response, "json");
    const text = vi.spyOn(response, "text");
    f.fetch.mockResolvedValue(response);
    await expect(f.create().sync()).rejects.toThrow(message);
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  });
});
