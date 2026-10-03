import OAuthProvider, { OAuthError } from "@cloudflare/workers-oauth-provider";

import { GitHubHandler } from "./github-handler.js";
import { McpApiHandler } from "./mcp.js";
import { runNag } from "./nag.js";
import type { WorkerEnv } from "./env.js";

export { OAuthFlowStore } from "./oauth-flow.js";
import { authorizationCodeGate } from "./oauth-code.js";
import { activateGrant, checkGrant, revokeGrant, GrantUnavailable, GrantInactive, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, type GrantIdentity } from "./oauth-grants.js";
export { OAuthGrantStore } from "./oauth-grants.js";
import { authorizedProps, publicOrigin, securityConfig } from "./security.js";

interface ExchangeContext { value?: { grantType: string; identity: GrantIdentity; expiresAt: number } }
export function createProvider(env: WorkerEnv, exchange: ExchangeContext = {}) {
  const origin = publicOrigin(env);
  return new OAuthProvider({
    apiRoute: "/mcp", apiHandler: McpApiHandler as any, defaultHandler: GitHubHandler as any,
    authorizeEndpoint: "/authorize", tokenEndpoint: "/token", clientRegistrationEndpoint: "/register",
    allowImplicitFlow: false, allowPlainPKCE: false, allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: false,
    scopesSupported: ["ynab"],
    resourceMetadata: { resource: `${origin}/mcp`, scopes_supported: ["ynab"] },
    accessTokenTTL: ACCESS_TTL_SECONDS, refreshTokenTTL: REFRESH_TTL_SECONDS,
    // Local pinned extension: the DO gate handles code reuse without revoking its winner.
    revokeGrantOnCodeReuse: false,
    grantRevocationCallback: options => revokeGrant(env, options),
    async tokenExchangeCallback(options) {
      const config = securityConfig(env);
      if (!authorizedProps(options.props, env, config) || options.props.userId !== options.userId || options.props.clientId !== options.clientId) throw new OAuthError("invalid_grant", { description: "Server policy changed; reconnect" });
      const identity = { userId: options.userId, clientId: options.clientId, authorizationId: options.props.authorizationId, grantId: options.grantId };
      if (options.grantType === "refresh_token") {
        try { await checkGrant(env, identity); }
        catch (error) { throw new OAuthError(error instanceof GrantUnavailable ? "temporarily_unavailable" : "invalid_grant", { description: error instanceof GrantUnavailable ? "Authorization storage temporarily unavailable" : "Authorization inactive; reconnect", statusCode: error instanceof GrantUnavailable ? 503 : 400 }); }
      }
      if (options.grantType === "authorization_code") {
        // Runs after provider client authentication and S256 verification, before
        // token issuance. KV alone cannot guarantee atomic code redemption.
        try { await authorizationCodeGate(env, options.props.authorizationId, "consume"); }
        catch (error) { throw new OAuthError(error instanceof GrantUnavailable ? "temporarily_unavailable" : "invalid_grant", { description: error instanceof GrantUnavailable ? "Authorization storage temporarily unavailable" : "Authorization code expired or already redeemed; reconnect", statusCode: error instanceof GrantUnavailable ? 503 : 400 }); }
      }
      exchange.value = { grantType: options.grantType, identity, expiresAt: Date.now() + REFRESH_TTL_SECONDS * 1000 };
      if (options.grantType === "authorization_code") return { newProps: { ...options.props, grantId: options.grantId } };
    },
    clientRegistrationCallback({ clientMetadata }) {
      const config = securityConfig(env);
      const uris = clientMetadata.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || uris.some(uri => typeof uri !== "string" || !config.redirectUris.includes(uri))) {
        return { status: 400, description: "Redirect URI is not approved by this server" };
      }
    },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const origin = publicOrigin(env);
      const url = new URL(request.url);
      if (url.origin !== origin) return new Response("Invalid origin", { status: 400 });
      const discovery = ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname);
      if (discovery && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD, OPTIONS" } });
      }
      // Only public metadata and an unauthenticated challenge/preflight bypass
      // private configuration. The provider answers these without storage/API use.
      const challenge = url.pathname === "/mcp" && !request.headers.has("authorization");
      if (!discovery && !challenge) {
        securityConfig(env);
        if (!env.OAUTH_KV) throw new Error("Missing OAuth KV");
      }
      // This closure belongs to one provider request; nothing is inferred from opaque tokens.
      const exchange: ExchangeContext = {};
      const response = await createProvider(env, exchange).fetch(request, { ...env, OAUTH_PROVIDER: undefined } as any, ctx);
      if (response.status === 200 && exchange.value) {
        const { grantType, identity, expiresAt } = exchange.value;
        try {
          if (grantType === "authorization_code") await activateGrant(env, identity, expiresAt);
          else await checkGrant(env, identity); // Fence a refresh that raced replacement/revocation.
        } catch (error) {
          // Never return persisted-but-inactive credentials, or roll back an ambiguous commit.
          return Response.json({ error: error instanceof GrantInactive ? "invalid_grant" : "temporarily_unavailable", error_description: error instanceof GrantInactive ? "Authorization inactive; reconnect" : "Authorization storage temporarily unavailable" }, { status: error instanceof GrantInactive ? 400 : 503, headers: { "cache-control": "no-store" } });
        }
      }
      response.headers.set("cache-control", "no-store");
      return request.method === "HEAD" ? new Response(null, response) : response;
    } catch {
      if (new URL(request.url).pathname === "/token") return Response.json({ error: "temporarily_unavailable", error_description: "Authorization service temporarily unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
      return new Response("Server authorization configuration or storage unavailable", { status: 503, headers: { "cache-control": "no-store" } });
    }
  },

  /**
   * Runs hourly. The nag itself only acts in the configured local hour, so the
   * reminder holds its wall-clock time through daylight saving changes.
   */
  async scheduled(_event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const outcome = await runNag(env);
      console.log("nag:", JSON.stringify(outcome));

      if (outcome.ran) {
        // Piggyback the OAuth housekeeping on a run that already did work.
        const purged = await createProvider(env).purgeExpiredData(env as any);
        console.log("oauth purge:", JSON.stringify(purged));
      }
    })());
  },
};
