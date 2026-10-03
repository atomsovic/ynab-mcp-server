import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Uses actual workerd fetch semantics, SQLite Durable Objects and local KV.
// Every outbound request is intercepted; no production config or credentials.
let script: string;
let runtime: Miniflare | undefined;
beforeAll(async () => {
  const bundle = await build({ entryPoints: ["src/worker/index.ts"], bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"] });
  script = bundle.outputFiles[0].text;
});
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });
function fixture(failure?: { stage: "token" | "profile"; status: number }) {
  const outbound: string[] = [];
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    bindings: {
      PUBLIC_ORIGIN: "https://worker.example", YNAB_ALLOWED_PLAN_ID: "11111111-1111-4111-8111-111111111111",
      YNAB_API_TOKEN: "synthetic", GITHUB_CLIENT_ID: "synthetic", GITHUB_CLIENT_SECRET: "synthetic",
      ALLOWED_GITHUB_LOGIN: "owner", OAUTH_ALLOWED_REDIRECT_URIS: '["https://client.example/callback"]',
    },
    kvNamespaces: ["OAUTH_KV"], durableObjects: { OAUTH_FLOWS: { className: "OAuthFlowStore", useSQLite: true } },
    outboundService(request) {
      outbound.push(request.url);
      const stage = request.url === "https://github.com/login/oauth/access_token" ? "token" : request.url === "https://api.github.com/user" ? "profile" : undefined;
      if (!stage) return new Response("Unexpected outbound request blocked", { status: 502 });
      if (failure?.stage === stage) return new Response("synthetic-private-upstream-error", { status: failure.status, headers: { location: "https://must-not-follow.example/" } });
      return Response.json(stage === "token" ? { access_token: "synthetic-github-token" } : { id: 123, login: "owner" });
    },
  }));
  return { outbound, call: (path: string, init: RequestInit = {}) => runtime!.dispatchFetch(`https://worker.example${path}`, { ...init, redirect: "manual" }) };
}
async function authorize(f: ReturnType<typeof fixture>) {
  const registration = await f.call("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }) });
  expect(registration.status).toBe(201);
  const { client_id } = await registration.json() as { client_id: string };
  const verifier = "v".repeat(43);
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://client.example/callback", state: "synthetic-client-state", code_challenge: challenge, code_challenge_method: "S256", resource: "https://worker.example/mcp" });
  const consent = await f.call(`/authorize?${query}`);
  expect(consent.status).toBe(200);
  const html = await consent.text(), cookie = consent.headers.get("set-cookie")!.split(";")[0];
  const flow = html.match(/name="flow" value="([^"]+)"/)![1], csrf = html.match(/name="csrf_token" value="([^"]+)"/)![1];
  const approved = await f.call("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://worker.example", cookie }, body: new URLSearchParams({ flow, csrf_token: csrf, decision: "approve" }).toString() });
  expect(approved.status).toBe(302);
  return { cookie, flow, client_id, verifier, callback: () => f.call(`/callback?${new URLSearchParams({ state: flow, code: "synthetic-upstream-code" })}`, { headers: { cookie } }) };
}

describe("Cloudflare runtime OAuth callback", () => {
  it("completes callback, redeems the code once, and serves authenticated MCP", async () => {
    const f = fixture(), a = await authorize(f);
    const callback = await a.callback();
    expect(callback.status).toBe(302);
    const destination = new URL(callback.headers.get("location")!);
    expect(destination.origin).toBe("https://client.example");
    expect(destination.searchParams.get("state")).toBe("synthetic-client-state");
    const tokenRequest: RequestInit = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: a.client_id, code: destination.searchParams.get("code")!, redirect_uri: "https://client.example/callback", code_verifier: a.verifier, resource: "https://worker.example/mcp" }).toString() };
    const exchange = await f.call("/token", tokenRequest); expect(exchange.status).toBe(200);
    const { access_token } = await exchange.json() as { access_token: string };
    const mcp = await f.call("/mcp", { method: "POST", headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(mcp.status).toBe(200); expect(await mcp.text()).toContain("ynab_apply_category_suggestions");
    expect((await f.call("/token", tokenRequest)).status).toBe(400);
    expect((await a.callback()).status).toBe(400);
    expect(f.outbound).toEqual(["https://github.com/login/oauth/access_token", "https://api.github.com/user"]);
  });
  it.each(["token", "profile"] as const)("rejects redirects and non-JSON failures from %s without following or exposing them", async stage => {
    // Separate flows per status: consumed callback state is intentionally not reusable.
    for (const status of [301, 302, 307, 308, 500]) {
      const f = fixture({ stage, status }), a = await authorize(f);
      const callback = await a.callback();
      expect(callback.status).toBe(401);
      const body = await callback.text();
      expect(body).toContain("GitHub sign-in failed");
      expect(body).not.toContain("synthetic-private-upstream-error");
      expect(callback.headers.get("location")).toBeNull();
      expect(callback.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(f.outbound).toEqual(stage === "token" ? ["https://github.com/login/oauth/access_token"] : ["https://github.com/login/oauth/access_token", "https://api.github.com/user"]);
      expect((await a.callback()).status).toBe(400);
      await runtime!.dispose(); runtime = undefined;
    }
  }, 20000);
});
