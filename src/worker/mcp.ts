import { DurablePlanStaging } from "./staging-client.js";
import { checkGrant, GrantUnavailable } from "./oauth-grants.js";
import { authorizedProps, securityConfig } from "./security.js";
import { accessPolicy } from "../accessPolicy.js";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import * as ynab from "ynab";

import { R2CategoryAuditStore } from "./categoryAudit.js";
import { registerAll } from "../registry.js";
import type { WorkerEnv } from "./env.js";

/**
 * The tool modules read configuration from `process.env` (they were written for
 * the stdio server). Workers has no ambient environment, so mirror the bindings
 * onto `process.env` before building the server. Safe here because this Worker
 * uses one server-wide YNAB credential rather than per-request credentials.
 */
function applyEnv(env: WorkerEnv) {
  process.env.YNAB_API_TOKEN = env.YNAB_API_TOKEN;
  const optionalBindings: Array<[string, string | undefined]> = [
    ["YNAB_PLAN_ID", env.YNAB_PLAN_ID],
    ["YNAB_BUDGET_ID", env.YNAB_BUDGET_ID],
    ["TYPESAFE_API_KEY", env.TYPESAFE_API_KEY],
    ["YNAB_AI_CATEGORIZATION", env.YNAB_AI_CATEGORIZATION],
  ];
  for (const [name, value] of optionalBindings) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

export function createServer(env: WorkerEnv, userId?: string) {
  const policy = accessPolicy(env);
  applyEnv(env);

  const server = new McpServer({
    name: "ynab-mcp-server",
    version: "0.4.0",
  });

  const api = new ynab.API(env.YNAB_API_TOKEN);
  registerAll(server, api, {
    ...policy,
    staging: env.PLAN_STAGING && userId ? new DurablePlanStaging(env.PLAN_STAGING, { userId, planId: policy.allowedPlanId }) : undefined,
    categoryAudit: env.CATEGORY_AUDIT ? new R2CategoryAuditStore(env.CATEGORY_AUDIT) : undefined,
  });

  return server;
}

/**
 * Serves /mcp. Behind OAuthProvider this is only reached with a valid access
 * token, so every request here belongs to an authorized grant.
 */
export const McpApiHandler = {
  async fetch(request: Request, env: WorkerEnv, ctx?: { props?: unknown }): Promise<Response> {
    try {
      const config = securityConfig(env);
      const props = ctx?.props;
      if ((props as { version?: unknown } | undefined)?.version !== 2) return inactive(config.origin);
      if (new URL(request.url).origin !== config.origin || !authorizedProps(props, env, config)) {
        return new Response("Authorization no longer matches server policy; reconnect", { status: 403, headers: { "cache-control": "no-store" } });
      }
      if (!props.grantId) return inactive(config.origin);
      try { await checkGrant(env, { ...props, grantId: props.grantId }); }
      catch (error) {
        return error instanceof GrantUnavailable ? new Response("Authorization storage temporarily unavailable", { status: 503, headers: { "cache-control": "no-store" } }) : inactive(config.origin);
      }
    } catch { return new Response("Server configuration unavailable", { status: 503 }); }
    if (new URL(request.url).pathname === "/mcp/diagnostics") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
      applyEnv(env);
      const policy = accessPolicy(env), names: string[] = [];
      registerAll({ registerTool(name) { names.push(name); } }, {} as ynab.API, { ...policy, staging: env.PLAN_STAGING ? new DurablePlanStaging(env.PLAN_STAGING, { userId: (ctx?.props as { userId: string }).userId, planId: policy.allowedPlanId }) : undefined });
      return Response.json({
        authorizationVersion: 2, toolMode: policy.toolMode, readOnly: policy.readOnly,
        aiOptInEnabled: env.YNAB_AI_CATEGORIZATION === "true", aiKeyConfigured: Boolean(env.TYPESAFE_API_KEY),
        suggestionsRegistered: names.includes("ynab_suggest_categories"), registeredToolCount: names.length,
      }, { headers: { "cache-control": "no-store" } });
    }
    const handler = createMcpHandler(() => createServer(env, (ctx?.props as { userId: string }).userId));
    try {
      return await handler.fetch(request);
    } finally {
      await handler.close();
    }
  },
};

function inactive(origin: string) {
  return new Response("Authorization inactive; reconnect", { status: 401, headers: { "cache-control": "no-store", "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"` } });
}
