import { GrantUnavailable } from "./oauth-grants.js";
import type { WorkerEnv } from "./env.js";

/** Each grant gets a random server-only ID; neither code nor verifier is stored here. */
export async function authorizationCodeGate(env: WorkerEnv, id: string, action: "create" | "consume") {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid grant binding");
  let response: Response;
  try { response = await env.OAUTH_FLOWS!.get(env.OAUTH_FLOWS!.idFromName(`code:${id}`)).fetch(`https://flow.internal/${action}-code`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(action === "create" ? { expiresAt: Date.now() + 600000 } : {}),
  }); } catch { throw new GrantUnavailable(); }
  if (response.status >= 500 || response.status === 429) throw new GrantUnavailable();
  if (!response.ok) throw new Error("Authorization code already redeemed or expired");
}
