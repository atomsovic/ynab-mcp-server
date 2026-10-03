import { authorizationCodeGate } from "./oauth-code.js";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "./env.js";
import { securityConfig, validateClient, type UserProps } from "./security.js";
import type { PendingFlow } from "./oauth-flow.js";

const COOKIE = "__Host-ynab_login";
const COOKIE_FLAGS = "HttpOnly; Secure; Path=/; SameSite=Lax";
const securityHeaders = {
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
};
function html(body: string, status = 200, cookie?: string, consentForm = false) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YNAB authorization</title>${body}`, {
    status, headers: { ...securityHeaders, ...(consentForm ? {
      "referrer-policy": "same-origin",
      // Browsers also enforce form-action on the POST's redirect destination.
      "content-security-policy": securityHeaders["content-security-policy"].replace("form-action 'self'", "form-action 'self' https://github.com/login/oauth/authorize"),
    } : {}), ...(cookie ? { "set-cookie": cookie } : {}) },
  });
}
function escape(value: string) { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
function token() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join(""); }
async function hash(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join(""); }
function browserToken(request: Request) {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
  const value = matches[0]?.slice(COOKIE.length + 1);
  if (matches.length !== 1 || !/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error("Invalid browser binding");
  return value!;
}
function redirect(location: string, cookie?: string) {
  return new Response(null, { status: 302, headers: { ...securityHeaders, location, ...(cookie ? { "set-cookie": cookie } : {}) } });
}
async function flowCall(env: WorkerEnv, id: string, action: string, body: unknown): Promise<PendingFlow> {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid flow identifier");
  const response = await env.OAUTH_FLOWS!.get(env.OAUTH_FLOWS!.idFromName(id)).fetch(`https://flow.internal/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Invalid or expired flow");
  return response.json() as Promise<PendingFlow>;
}
function one(url: URL, name: string) {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0] || values[0].length > 2048) throw new Error("Invalid callback parameter");
  return values[0];
}

export const GitHubHandler = {
  async fetch(request: Request, env: WorkerEnv & { OAUTH_PROVIDER: OAuthHelpers }): Promise<Response> {
    let config: ReturnType<typeof securityConfig>;
    try { config = securityConfig(env); } catch { return html("<h1>Server configuration unavailable</h1>", 503); }
    const url = new URL(request.url);
    if (url.origin !== config.origin) return html("<h1>Invalid origin</h1>", 400);
    const clearCookie = `${COOKIE}=; ${COOKIE_FLAGS}; Max-Age=0`;
    try {
      if (url.pathname === "/authorize" && request.method === "GET") {
        // Reject ambiguous parameters before handing the request to the provider.
        for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw new Error("Duplicate parameter");
        const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
        validateClient(authRequest, client, config);
        const id = token(), browser = token(), csrf = token();
        await flowCall(env, id, "create", { flow: {
          authRequest, browserHash: await hash(browser), csrfHash: await hash(csrf), expiresAt: Date.now() + 600000,
          stage: "consent", allowedPlanId: config.allowedPlanId, mode: config.mode, origin: config.origin,
        } satisfies PendingFlow });
        // Form POST navigations under no-referrer send Origin:null. Keep the
        // strict origin check and allow same-origin referrers only on this form.
        return html(`<h1>Authorize this MCP client?</h1><p>Only approve a connection you started.</p><dl><dt>Client name (unverified)</dt><dd>${escape(client!.clientName ?? "Unnamed")}</dd><dt>Client ID</dt><dd>${escape(authRequest.clientId)}</dd><dt>Return address</dt><dd>${escape(authRequest.redirectUri)}</dd><dt>Selected plan</dt><dd>${escape(config.allowedPlanId)}</dd><dt>Access</dt><dd>${escape(config.mode)}</dd></dl><p>${config.mode === "full" ? "Full mode permits unaudited general writes." : config.mode === "read-only" ? "Reads only; no YNAB changes." : "Reads and audited category application only; no general transaction writes."}</p><form method="post" action="/authorize"><input type="hidden" name="flow" value="${id}"><input type="hidden" name="csrf_token" value="${csrf}"><button name="decision" value="approve">Approve and sign in with GitHub</button><button name="decision" value="deny">Deny</button></form>`, 200, `${COOKIE}=${browser}; ${COOKIE_FLAGS}; Max-Age=600`, true);
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        if (request.headers.get("origin") !== config.origin || !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) throw new Error("Invalid consent origin");
        const body = await request.text();
        if (body.length > 4096) throw new Error("Oversized consent");
        const form = new URLSearchParams(body);
        for (const key of ["flow", "csrf_token", "decision"]) if (form.getAll(key).length !== 1) throw new Error("Invalid consent");
        const decision = form.get("decision");
        if (decision !== "approve" && decision !== "deny") throw new Error("Invalid decision");
        const id = form.get("flow")!;
        const flow = await flowCall(env, id, decision, { browserHash: await hash(browserToken(request)), csrfHash: await hash(form.get("csrf_token")!) });
        if (decision === "deny") return html("<h1>Connection denied</h1>", 200, clearCookie);
        if (flow.allowedPlanId !== config.allowedPlanId || flow.mode !== config.mode || flow.origin !== config.origin) throw new Error("Policy changed");
        validateClient(flow.authRequest, await env.OAUTH_PROVIDER.lookupClient(flow.authRequest.clientId), config);
        const github = new URL("https://github.com/login/oauth/authorize");
        github.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
        github.searchParams.set("redirect_uri", `${config.origin}/callback`);
        github.searchParams.set("scope", "read:user");
        github.searchParams.set("state", id);
        return redirect(github.href);
      }
      if (url.pathname === "/callback" && request.method === "GET") {
        const state = one(url, "state"), code = one(url, "code");
        if (url.searchParams.has("error")) throw new Error("Upstream rejected authorization");
        const flow = await flowCall(env, state, "consume", { browserHash: await hash(browserToken(request)) });
        if (flow.allowedPlanId !== config.allowedPlanId || flow.mode !== config.mode || flow.origin !== config.origin) throw new Error("Policy changed");
        validateClient(flow.authRequest, await env.OAUTH_PROVIDER.lookupClient(flow.authRequest.clientId), config);
        // workerd supports manual, not error; reject redirects before reading bodies.
        const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST", redirect: "manual", headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${config.origin}/callback` }),
        });
        if (!tokenResponse.ok) return html("<h1>GitHub sign-in failed</h1>", 401, clearCookie);
        const tokenBody = await tokenResponse.json() as { access_token?: string };
        if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token) return html("<h1>GitHub sign-in failed</h1>", 401, clearCookie);
        const userResponse = await fetch("https://api.github.com/user", { redirect: "manual", headers: {
          accept: "application/vnd.github+json", authorization: `Bearer ${tokenBody.access_token}`, "user-agent": "ynab-mcp-server",
        } });
        if (!userResponse.ok) return html("<h1>GitHub sign-in failed</h1>", 401, clearCookie);
        const user = await userResponse.json() as { id?: number; login?: string };
        if (!Number.isSafeInteger(user.id) || typeof user.login !== "string" || user.login.toLowerCase() !== env.ALLOWED_GITHUB_LOGIN.toLowerCase()) return html("<h1>Access denied</h1>", 403, clearCookie);
        const authorizationId = token();
        await authorizationCodeGate(env, authorizationId, "create");
        const props: UserProps = { version: 1, authorizationId, login: user.login, clientId: flow.authRequest.clientId,
          redirectUri: flow.authRequest.redirectUri, allowedPlanId: config.allowedPlanId, mode: config.mode, origin: config.origin };
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: flow.authRequest,
          userId: String(user.id), metadata: { label: user.login }, scope: flow.authRequest.scope, props });
        return redirect(redirectTo, clearCookie);
      }
      if (["/authorize", "/callback"].includes(url.pathname)) return html("<h1>Method not allowed</h1>", 405);
      if (url.pathname === "/" && request.method === "GET") return html("<h1>Private YNAB MCP server</h1><p>Connect through your configured MCP client to begin authorization.</p>");
      return html("<h1>Not found</h1>", 404);
    } catch {
      return html("<h1>Authorization failed</h1><p>Invalid, expired or already used request. Start a new connection from your MCP client.</p>", 400, url.pathname === "/callback" ? clearCookie : undefined);
    }
  },
};
