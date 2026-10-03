import { OAuthGrantStore } from "../../worker/oauth-grants.js";
import { memoryNamespace } from "./durable.js";
import { vi } from "vitest";
import { OAuthFlowStore } from "../../worker/oauth-flow.js";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "../../worker/env.js";

export const selectedPlan = "11111111-1111-4111-8111-111111111111";
export const authRequest: AuthRequest = { responseType: "code", clientId: "client-1", redirectUri: "https://client.example/callback", scope: [], state: "client-state", codeChallenge: "x".repeat(43), codeChallengeMethod: "S256" };
export function memoryFlows() {
  const instances = new Map<string, OAuthFlowStore>();
  return {
    idFromName(id: string) { return id; },
    get(id: string) {
      if (!instances.has(id)) {
        let data = new Map<string, unknown>();
        let queue = Promise.resolve();
        const storage = {
          async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
            const run = queue.then(async () => {
              const copy = structuredClone(data);
              const result = await fn({
                async get(key: string) { return copy.get(key); },
                async put(key: string, value: unknown) { copy.set(key, structuredClone(value)); },
                async delete(key: string) { return copy.delete(key); },
                async setAlarm() {},
              });
              data = copy; return result;
            });
            queue = run.then(() => {}, () => {}); return run;
          },
          async deleteAll() { data.clear(); },
        };
        instances.set(id, new OAuthFlowStore({ storage } as unknown as DurableObjectState));
      }
      return { fetch: async (url: string, options?: RequestInit) => instances.get(id)!.fetch(new Request(url, options)) };
    },
  };
}
export function oauthFixture() {
  const helpers = {
    parseAuthRequest: vi.fn().mockResolvedValue(structuredClone(authRequest)),
    lookupClient: vi.fn().mockResolvedValue({ clientId: "client-1", redirectUris: [authRequest.redirectUri], clientName: "Synthetic Client" }),
    completeAuthorization: vi.fn().mockResolvedValue({ redirectTo: "https://client.example/callback?code=synthetic&state=client-state" }),
  };
  const env = {
    YNAB_API_TOKEN: "synthetic-pat", YNAB_ALLOWED_PLAN_ID: selectedPlan,
    GITHUB_CLIENT_ID: "synthetic-app", GITHUB_CLIENT_SECRET: "synthetic-secret", ALLOWED_GITHUB_LOGIN: "owner",
    PUBLIC_ORIGIN: "https://worker.example", OAUTH_ALLOWED_REDIRECT_URIS: JSON.stringify([authRequest.redirectUri]),
    OAUTH_FLOWS: memoryFlows(), OAUTH_GRANTS: memoryNamespace(OAuthGrantStore), OAUTH_PROVIDER: helpers,
  } as unknown as WorkerEnv & { OAUTH_PROVIDER: OAuthHelpers };
  return { env, helpers };
}
