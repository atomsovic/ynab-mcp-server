import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import worker from "../worker/index.js";
import { oauthFixture, selectedPlan } from "./helpers/oauth.js";
import { securityConfig } from "../worker/security.js";

function fixture() {
  const { OAUTH_PROVIDER: _mockHelpers, ...env } = oauthFixture().env;
  const data = new Map<string, string>();
  env.OAUTH_KV = {
    async get(key: string, options?: string | { type?: string }) {
      const value = data.get(key);
      return value === undefined ? null : (options === "json" || (typeof options === "object" && options.type === "json")) ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) { data.set(key, value); },
    async delete(key: string) { data.delete(key); },
    async list(options: { prefix?: string } = {}) { return { keys: [...data.keys()].filter(k => k.startsWith(options.prefix ?? "")).map(name => ({ name })), list_complete: true, cursor: "" }; },
  } as unknown as KVNamespace;
  return { env, data };
}
async function call(f: ReturnType<typeof fixture>, path: string, init?: RequestInit) {
  return worker.fetch(new Request(`https://worker.example${path}`, init), f.env, { waitUntil() {} } as unknown as ExecutionContext);
}
function form(body: Record<string, string>): RequestInit { return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }; }
async function rpc(response: Response) { const text = await response.text(); return JSON.parse(text.split("\n").find(l => l.startsWith("data:"))?.slice(5) ?? text); }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("actual OAuth provider endpoints with synthetic stores", () => {
  it("enforces registration policy, PKCE, browser consent, token exchange and MCP access end to end", async () => {
    const f = fixture();
    const denied = await call(f, "/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"], token_endpoint_auth_method: "none" }) });
    expect(denied.status).toBe(400);
    const registered = await call(f, "/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Synthetic", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }) });
    expect(registered.status).toBe(201);
    const { client_id } = await registered.json() as { client_id: string };
    const verifier = "v".repeat(43);
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const query = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://client.example/callback", state: "mcp-client-state", code_challenge: challenge, code_challenge_method: "S256", resource: "https://worker.example/mcp" });
    const noPkce = new URLSearchParams(query); noPkce.delete("code_challenge");
    expect((await call(f, `/authorize?${noPkce}`)).status).toBe(400);
    const authorized = await call(f, `/authorize?${query}`);
    expect(authorized.status).toBe(200);
    const cookie = authorized.headers.get("set-cookie")!.split(";")[0];
    const html = await authorized.text();
    const flow = html.match(/name="flow" value="([^"]+)"/)![1];
    const csrf = html.match(/name="csrf_token" value="([^"]+)"/)![1];
    const approved = await call(f, "/authorize", { ...form({ flow, csrf_token: csrf, decision: "approve" }), headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: "https://worker.example" } });
    expect(approved.status).toBe(302);
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "synthetic-upstream" })).mockResolvedValueOnce(Response.json({ id: 123, login: "owner" }));
    vi.stubGlobal("fetch", fetch);
    const callback = await call(f, `/callback?state=${flow}&code=synthetic-upstream-code`, { headers: { cookie } });
    expect(callback.status).toBe(302);
    const clientRedirect = new URL(callback.headers.get("location")!);
    expect(clientRedirect.origin).toBe("https://client.example");
    expect(clientRedirect.searchParams.get("state")).toBe("mcp-client-state");
    const tokenRequest = { grant_type: "authorization_code", client_id, code: clientRedirect.searchParams.get("code")!, redirect_uri: "https://client.example/callback", code_verifier: verifier, resource: "https://worker.example/mcp" };
    expect((await call(f, "/token", form({ ...tokenRequest, code_verifier: "w".repeat(43) }))).status).toBe(400);
    const redeemed = await Promise.all([call(f, "/token", form(tokenRequest)), call(f, "/token", form(tokenRequest))]);
    expect(redeemed.map(r => r.status).sort()).toEqual([200, 400]);
    const token = redeemed.find(r => r.status === 200)!;
    const tokens = await token.json() as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toBeTruthy();
    const request: RequestInit = { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) };
    const mcp = await call(f, "/mcp", request);
    expect(mcp.status).toBe(200);
    const result = await rpc(mcp);
    const names = result.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("ynab_apply_category_suggestions"); expect(names).not.toContain("ynab_update_transaction");
    const forbidden = await call(f, "/mcp", { ...request, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ynab_update_transaction", arguments: { planId: selectedPlan, transactionId: "synthetic" } } }) });
    const failure = await rpc(forbidden); expect(failure.error || failure.result?.isError).toBeTruthy();
    expect((await call(f, "/mcp", { ...request, headers: { "content-type": "application/json" } })).status).toBe(401);
    f.env.YNAB_READ_ONLY = "true";
    expect((await call(f, "/mcp", request)).status).toBe(403);
    delete f.env.YNAB_READ_ONLY;
    f.env.YNAB_TOOL_MODE = "full";
    expect((await call(f, "/token", form({ grant_type: "refresh_token", client_id, refresh_token: tokens.refresh_token }))).status).toBe(400);
    expect((await call(f, "/mcp", request)).status).toBe(403);
    f.env.YNAB_TOOL_MODE = "category-only";
    f.env.YNAB_ALLOWED_PLAN_ID = "22222222-2222-4222-8222-222222222222";
    expect((await call(f, "/mcp", request)).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["/register", "/authorize", "/callback", "/token", "/mcp"])("fails closed with missing selected budget on %s", async path => {
    const f = fixture(); delete f.env.YNAB_ALLOWED_PLAN_ID;
    expect((await call(f, path, { headers: { authorization: "Bearer synthetic" } })).status).toBe(503);
    expect(f.data.size).toBe(0);
  });
  it("advertises only the configured origin and denies alternate hosts and internal flow routes", async () => {
    const f = fixture();
    const metadata = await call(f, "/.well-known/oauth-authorization-server");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ authorization_endpoint: "https://worker.example/authorize", token_endpoint: "https://worker.example/token", registration_endpoint: "https://worker.example/register" });
    expect((await worker.fetch(new Request("https://evil.example/authorize"), f.env, {} as ExecutionContext)).status).toBe(400);
    expect((await call(f, "/consume")).status).toBe(404);
  });
});

describe("security configuration fails closed", () => {
  it.each([
    { PUBLIC_ORIGIN: "http://worker.example" }, { PUBLIC_ORIGIN: "https://worker.example/" },
    { OAUTH_ALLOWED_REDIRECT_URIS: "[]" }, { OAUTH_ALLOWED_REDIRECT_URIS: "not-json" },
    { OAUTH_ALLOWED_REDIRECT_URIS: '["https://*.example/callback"]' },
    { OAUTH_ALLOWED_REDIRECT_URIS: '["https://user:pass@client.example/callback"]' },
    { OAUTH_ALLOWED_REDIRECT_URIS: '["http://localhost/callback"]' },
    { OAUTH_ALLOWED_REDIRECT_URIS: '["https://localhost/callback"]' },
    { OAUTH_ALLOWED_REDIRECT_URIS: '["https://localhost./callback"]' },
    { OAUTH_ALLOWED_REDIRECT_URIS: '["https://foo.localhost./callback"]' },
    { OAUTH_ALLOWED_REDIRECT_URIS: '["https://127.0.0.1/callback"]' },
    { OAUTH_ALLOWED_REDIRECT_URIS: '["https://[::1]/callback"]' },
    { OAUTH_ALLOWED_CLIENT_IDS: "[]" }, { GITHUB_CLIENT_SECRET: "" }, { OAUTH_FLOWS: undefined },
  ])("rejects %j", overrides => expect(() => securityConfig({ ...oauthFixture().env, ...overrides })).toThrow());
});


describe("public OAuth bootstrap with incomplete private configuration", () => {
  const paths = ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"];
  it.each([undefined, "", "[]", "not-json", '["https://evil.example/*"]'])("publishes discovery but denies operations with redirect allowlist %j", async allowlist => {
    const f = fixture(); f.env.OAUTH_ALLOWED_REDIRECT_URIS = allowlist;
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const path of paths) {
      const response = await call(f, path);
      expect(response.status).toBe(200);
      const body = await response.json();
      if (path.endsWith("oauth-authorization-server")) {
        expect(body).toMatchObject({ issuer: "https://worker.example", registration_endpoint: "https://worker.example/register", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: false });
      } else expect(body).toEqual({ resource: "https://worker.example/mcp", authorization_servers: ["https://worker.example"], scopes_supported: ["ynab"], bearer_methods_supported: ["header"] });
      expect(JSON.stringify(body)).not.toMatch(/synthetic|11111111|owner|evil/);
    }
    for (const path of ["/register", "/authorize", "/callback", "/token", "/mcp"]) {
      const response = await call(f, path, { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(503);
    }
    const challenge = await call(f, "/mcp", { method: "POST", body: JSON.stringify({ method: "tools/list" }) });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain('resource_metadata="https://worker.example/.well-known/oauth-protected-resource/mcp"');
    expect(await challenge.text()).toBe("");
    expect(f.data.size).toBe(0); expect(fetch).not.toHaveBeenCalled();
  });
  it("needs only a canonical public origin, supports HEAD/preflight, and leaks no private settings", async () => {
    const f = fixture(); f.env = { PUBLIC_ORIGIN: "https://worker.example" } as typeof f.env;
    for (const path of paths) expect((await call(f, path)).status).toBe(200);
    const head = await call(f, paths[0], { method: "HEAD" });
    expect(head.status).toBe(200); expect(await head.text()).toBe("");
    const options = await call(f, "/mcp", { method: "OPTIONS", headers: { origin: "https://client.example" } });
    expect(options.status).toBe(204);
    const challenge = await call(f, "/mcp", { headers: { origin: "https://client.example" } });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
    expect((await call(f, paths[0], { method: "POST" })).status).toBe(405);
  });
  it("never trusts forwarded hosts or serves discovery on preview origins", async () => {
    const f = fixture(); delete f.env.OAUTH_ALLOWED_REDIRECT_URIS;
    for (const path of [...paths, "/mcp"]) {
      const response = await worker.fetch(new Request(`https://preview.example${path}`, { headers: { "x-forwarded-host": "worker.example" } }), f.env, {} as ExecutionContext);
      expect(response.status).toBe(400);
    }
    const metadata = await call(f, paths[0], { headers: { "x-forwarded-host": "evil.example" } });
    expect((await metadata.json() as { issuer: string }).issuer).toBe("https://worker.example");
    for (const origin of [undefined, "http://worker.example", "https://worker.example/", "https://localhost"]) {
      f.env.PUBLIC_ORIGIN = origin;
      expect((await call(f, paths[0])).status).toBe(503);
    }
  });
});
