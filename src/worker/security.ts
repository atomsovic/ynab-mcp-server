import { accessPolicy } from "../accessPolicy.js";
import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "./env.js";

function stringList(raw: string | undefined): string[] {
  const values: unknown = JSON.parse(raw ?? "null");
  if (!Array.isArray(values) || !values.length || values.length > 20 || values.some(v => typeof v !== "string" || !v || v.length > 2048)) throw new Error("Invalid allowlist");
  return values;
}
function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.hostname.endsWith(".") || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith("[") ||
      url.protocol !== "https:" || url.username || url.password || url.hash || value.includes("*")) throw new Error("Invalid HTTPS URL");
  return url;
}
export function publicOrigin(env: Pick<WorkerEnv, "PUBLIC_ORIGIN">): string {
  const origin = env.PUBLIC_ORIGIN ?? "";
  if (httpsUrl(origin).origin !== origin) throw new Error("PUBLIC_ORIGIN must be a canonical HTTPS origin");
  return origin;
}
export function securityConfig(env: WorkerEnv) {
  const policy = accessPolicy(env);
  const origin = publicOrigin(env);
  const redirectUris = stringList(env.OAUTH_ALLOWED_REDIRECT_URIS);
  for (const uri of redirectUris) if (httpsUrl(uri).href !== uri) throw new Error("Noncanonical redirect URI");
  const clientIds = env.OAUTH_ALLOWED_CLIENT_IDS === undefined ? undefined : stringList(env.OAUTH_ALLOWED_CLIENT_IDS);
  if (![env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, env.YNAB_API_TOKEN, env.ALLOWED_GITHUB_LOGIN].every(value => typeof value === "string" && value.trim())) throw new Error("Missing security configuration");
  if (!env.OAUTH_GRANTS) throw new Error("Missing active grant storage");
  if (!env.OAUTH_FLOWS) throw new Error("Missing OAuth flow storage");
  return { ...policy, origin, redirectUris, clientIds, mode: policy.readOnly ? "read-only" : policy.toolMode };
}
export type SecurityConfig = ReturnType<typeof securityConfig>;
export function validateClient(request: AuthRequest, client: ClientInfo | null, config: SecurityConfig) {
  if (!client || client.clientId !== request.clientId || !client.redirectUris.includes(request.redirectUri) ||
      !config.redirectUris.includes(request.redirectUri) || (config.clientIds && !config.clientIds.includes(request.clientId)) ||
      /^https?:/i.test(request.clientId) || request.responseType !== "code" || request.codeChallengeMethod !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge ?? "") || request.scope.some(scope => scope !== "ynab") ||
      (request.resource !== undefined && request.resource !== `${config.origin}/mcp`)) throw new Error("Client request not allowed");
}
export interface UserProps extends Record<string, unknown> {
  version: 2;
  userId: string;
  grantId?: string;
  authorizationId: string;
  login: string;
  clientId: string;
  redirectUri: string;
  allowedPlanId: string;
  mode: string;
  origin: string;
}
export function authorizedProps(props: unknown, env: WorkerEnv, config: SecurityConfig): props is UserProps {
  const p = props as Partial<UserProps> | undefined;
  return Boolean(p && p.version === 2 && typeof p.userId === "string" && /^[0-9]{1,20}$/.test(p.userId) && typeof p.authorizationId === "string" && /^[0-9a-f]{64}$/.test(p.authorizationId) && typeof p.login === "string" && p.login.toLowerCase() === env.ALLOWED_GITHUB_LOGIN.toLowerCase() &&
    p.allowedPlanId === config.allowedPlanId && p.mode === config.mode && p.origin === config.origin &&
    typeof p.clientId === "string" && p.clientId.length > 0 && typeof p.redirectUri === "string" && config.redirectUris.includes(p.redirectUri) &&
    (!config.clientIds || config.clientIds.includes(p.clientId)));
}
