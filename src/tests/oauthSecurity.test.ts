import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubHandler } from "../worker/github-handler.js";
import { authRequest, oauthFixture } from "./helpers/oauth.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function begin(f = oauthFixture()) {
  const response = await GitHubHandler.fetch(new Request("https://worker.example/authorize?client_id=client-1"), f.env);
  const page = await response.text();
  const flow = page.match(/name="flow" value="([^"]+)"/)?.[1] ?? "missing";
  const csrf = page.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? "missing";
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { ...f, response, page, flow, csrf, cookie };
}
async function consent(f: Awaited<ReturnType<typeof begin>>, overrides: { cookie?: string; csrf?: string; origin?: string; decision?: string } = {}) {
  return GitHubHandler.fetch(new Request("https://worker.example/authorize", { method: "POST", headers: {
    "content-type": "application/x-www-form-urlencoded", cookie: overrides.cookie ?? f.cookie, origin: overrides.origin ?? "https://worker.example",
  }, body: new URLSearchParams({ flow: f.flow, csrf_token: overrides.csrf ?? f.csrf, decision: overrides.decision ?? "approve" }) }), f.env);
}
async function callback(f: Awaited<ReturnType<typeof begin>>, state = f.flow, cookie = f.cookie) {
  return GitHubHandler.fetch(new Request(`https://worker.example/callback?code=synthetic&state=${state}`, { headers: { cookie } }), f.env);
}
function mockGitHub() {
  return vi.fn().mockResolvedValueOnce(Response.json({ access_token: "synthetic-github-token" })).mockResolvedValueOnce(Response.json({ id: 123, login: "owner", name: "Owner" }));
}

describe("browser-bound OAuth consent", () => {
  it("renders consent before GitHub with security headers and exact client destination", async () => {
    const f = await begin();
    expect(f.response.status).toBe(200);
    expect(f.page).toContain(authRequest.redirectUri);
    expect(f.page).toContain("client-1");
    expect(f.response.headers.get("location")).toBeNull();
    expect(f.response.headers.get("set-cookie")).toMatch(/__Host-ynab_login=.*HttpOnly; Secure; Path=\/; SameSite=Lax/);
    expect(f.response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(f.response.headers.get("cache-control")).toBe("no-store");
    expect(f.response.headers.get("referrer-policy")).toBe("same-origin");
    expect(f.response.headers.get("content-security-policy")).toContain("form-action 'self' https://github.com/login/oauth/authorize;");
  });
  it("requires consent, then completes one authorization with bound policy", async () => {
    const f = await begin();
    const fetch = mockGitHub(); vi.stubGlobal("fetch", fetch);
    expect((await callback(f)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    const redirect = await consent(f);
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("state")).toBe(f.flow);
    const result = await callback(f);
    expect(result.status).toBe(302);
    expect(f.helpers.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({ userId: "123", props: expect.objectContaining({ version: 1, login: "owner", clientId: "client-1", allowedPlanId: f.env.YNAB_ALLOWED_PLAN_ID, mode: "category-only" }) }));
    expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect(result.headers.get("content-security-policy")).toContain("form-action 'self';");
    expect((await callback(f)).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([{ cookie: "" }, { csrf: "forged" }, { origin: "https://evil.example" }, { origin: "null" }])("rejects forged consent %j", async overrides => {
    const f = await begin(); expect((await consent(f, overrides)).status).toBe(400);
    expect(f.helpers.completeAuthorization).not.toHaveBeenCalled();
  });
  it("consumes denied consent and prevents replay of approval", async () => {
    const f = await begin(); expect((await consent(f, { decision: "deny" })).status).toBe(200);
    expect((await consent(f)).status).toBe(400); expect((await callback(f)).status).toBe(400);
  });
  it("rejects missing, tampered and browser-mismatched callbacks before token exchange", async () => {
    const f = await begin(); await consent(f);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await callback(f, "forged")).status).toBe(400);
    expect((await callback(f, f.flow, "")).status).toBe(400);
    expect((await callback(f, f.flow, "__Host-ynab_login=" + "0".repeat(64))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("expires consent and callback state after ten minutes", async () => {
    const f = await begin(); await consent(f);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600001);
    expect((await callback(f)).status).toBe(400);
    expect((await consent(f)).status).toBe(400);
  });
  it("allows only one concurrent consent and callback consumption", async () => {
    const f = await begin();
    expect((await Promise.all([consent(f), consent(f)])).map(r => r.status).sort()).toEqual([302, 400]);
    const fetch = mockGitHub(); vi.stubGlobal("fetch", fetch);
    expect((await Promise.all([callback(f), callback(f)])).map(r => r.status).sort()).toEqual([302, 400]);
    expect(f.helpers.completeAuthorization).toHaveBeenCalledTimes(1);
  });
  it("escapes untrusted client metadata and never reflects upstream errors", async () => {
    const fixture = oauthFixture(); fixture.helpers.lookupClient.mockResolvedValue({ clientId: "client-1", redirectUris: [authRequest.redirectUri], clientName: '<script>alert("x")</script>' });
    const f = await begin(fixture); expect(f.page).not.toContain("<script>"); expect(f.page).toContain("&lt;script&gt;");
    await consent(f); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "<script>secret</script>" }, { status: 400 })));
    const failed = await callback(f); expect(failed.status).toBe(401); expect(await failed.text()).not.toContain("secret");
    expect(f.helpers.completeAuthorization).not.toHaveBeenCalled();
  });
  it.each([
    { redirectUri: "https://evil.example/callback" }, { responseType: "token" }, { codeChallengeMethod: "plain" }, { codeChallenge: undefined }, { scope: ["admin"] }, { resource: "https://other.example/mcp" },
  ])("rejects unauthorized request properties %j", async overrides => {
    const f = oauthFixture(); f.helpers.parseAuthRequest.mockResolvedValue({ ...authRequest, ...overrides });
    expect((await begin(f)).response.status).toBe(400);
  });
  it("rejects a removed client or changed budget policy at callback", async () => {
    const f = await begin(); await consent(f); f.helpers.lookupClient.mockResolvedValue(null);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await callback(f)).status).toBe(400); expect(fetch).not.toHaveBeenCalled();
    const g = await begin(); await consent(g); g.env.YNAB_ALLOWED_PLAN_ID = "22222222-2222-4222-8222-222222222222";
    expect((await callback(g)).status).toBe(400);
  });
  it("fails closed when flow storage or code-gate storage is unavailable", async () => {
    const fixture = oauthFixture();
    fixture.env.OAUTH_FLOWS = { idFromName: () => "synthetic", get: () => ({ fetch: async () => { throw new Error("private storage details"); } }) } as unknown as DurableObjectNamespace;
    const failed = await begin(fixture);
    expect(failed.response.status).toBe(400);
    expect(failed.page).not.toContain("private storage details");
    expect(fixture.helpers.completeAuthorization).not.toHaveBeenCalled();
    const f = await begin(); await consent(f);
    const flows = f.env.OAUTH_FLOWS!;
    f.env.OAUTH_FLOWS = { idFromName: (id: string) => flows.idFromName(id), get: (id: DurableObjectId) => {
      const stub = flows.get(id);
      return { fetch: async (url: string, options?: RequestInit) => url.endsWith("/create-code") ? new Response(null, { status: 503 }) : stub.fetch(url, options) };
    } } as unknown as DurableObjectNamespace;
    vi.stubGlobal("fetch", mockGitHub());
    expect((await callback(f)).status).toBe(400);
    expect(f.helpers.completeAuthorization).not.toHaveBeenCalled();
  });
  it("refuses the wrong GitHub identity", async () => {
    const f = await begin(); await consent(f);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ access_token: "synthetic" })).mockResolvedValueOnce(Response.json({ id: 456, login: "other", name: "<script>" })));
    expect((await callback(f)).status).toBe(403); expect(f.helpers.completeAuthorization).not.toHaveBeenCalled();
  });
});
