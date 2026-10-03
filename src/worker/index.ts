import OAuthProvider, { OAuthError } from "@cloudflare/workers-oauth-provider";

import { GitHubHandler } from "./github-handler.js";
import { McpApiHandler } from "./mcp.js";
import { runNag } from "./nag.js";
import type { WorkerEnv } from "./env.js";

export { OAuthFlowStore } from "./oauth-flow.js";
import { authorizationCodeGate } from "./oauth-code.js";
import { authorizedProps, publicOrigin, securityConfig } from "./security.js";

export function createProvider(env: WorkerEnv) {
  const origin = publicOrigin(env);
  return new OAuthProvider({
    apiRoute: "/mcp", apiHandler: McpApiHandler as any, defaultHandler: GitHubHandler as any,
    authorizeEndpoint: "/authorize", tokenEndpoint: "/token", clientRegistrationEndpoint: "/register",
    allowImplicitFlow: false, allowPlainPKCE: false, allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: false,
    scopesSupported: ["ynab"],
    resourceMetadata: { resource: `${origin}/mcp`, scopes_supported: ["ynab"] },
    accessTokenTTL: 3600, refreshTokenTTL: 604800,
    async tokenExchangeCallback(options) {
      const config = securityConfig(env);
      if (!authorizedProps(options.props, env, config)) throw new OAuthError("invalid_grant", { description: "Server policy changed; reconnect" });
      if (options.grantType === "authorization_code") {
        // Runs after provider client authentication and S256 verification, before
        // token issuance. KV alone cannot guarantee atomic code redemption.
        try { await authorizationCodeGate(env, options.props.authorizationId, "consume"); }
        catch { throw new OAuthError("invalid_grant", { description: "Authorization code expired or already redeemed; reconnect" }); }
      }
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
      const response = await createProvider(env).fetch(request, { ...env, OAUTH_PROVIDER: undefined } as any, ctx);
      response.headers.set("cache-control", "no-store");
      return request.method === "HEAD" ? new Response(null, response) : response;
    } catch {
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
