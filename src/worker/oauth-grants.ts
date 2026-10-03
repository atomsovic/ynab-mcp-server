import type { WorkerEnv } from "./env.js";

export const REFRESH_TTL_SECONDS = 604800;
export const ACCESS_TTL_SECONDS = 3600;
const PENDING_MS = 600000;
const idPattern = /^[0-9a-f]{64}$/;
interface Active { authorizationId: string; grantId: string; expiresAt: number }
interface RecordState { generation: string; active?: Active }
interface Candidate { generation: string; expiresAt: number }

/** Separate from login flows: never delete the generation/tombstone on an alarm. */
export class OAuthGrantStore {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let input: { authorizationId?: string; grantId?: string; expiresAt?: number };
    try { input = await request.json(); } catch { return new Response(null, { status: 400 }); }
    if (!input || typeof input !== "object") return new Response(null, { status: 400 });
    const action = new URL(request.url).pathname;
    const { authorizationId, grantId, expiresAt } = input;
    if (action !== "/revoke" && (typeof authorizationId !== "string" || !idPattern.test(authorizationId))) return new Response(null, { status: 400 });
    if (["/activate", "/check", "/revoke"].includes(action) && (typeof grantId !== "string" || !grantId || grantId.length > 256)) return new Response(null, { status: 400 });
    return this.state.storage.transaction(async tx => {
      const now = Date.now();
      const state = await tx.get<RecordState>("state");
      const key = `pending:${authorizationId}`;
      if (action === "/check") {
        return new Response(null, { status: state?.active && state.active.authorizationId === authorizationId && state.active.grantId === grantId && state.active.expiresAt > now ? 200 : 401 });
      }
      if (action === "/revoke") {
        if (state?.active?.grantId === grantId) await tx.put("state", { generation: crypto.randomUUID() } satisfies RecordState);
        return Response.json({});
      }
      if (action === "/begin") {
        if (!Number.isSafeInteger(expiresAt) || expiresAt! <= now || expiresAt! > now + PENDING_MS) return new Response(null, { status: 400 });
        const candidates = await tx.list<Candidate>({ prefix: "pending:" });
        for (const [k, value] of candidates) if (value.expiresAt <= now) { await tx.delete(k); candidates.delete(k); }
        if (candidates.has(key) || state?.active?.authorizationId === authorizationId) return new Response(null, { status: 409 });
        if (candidates.size >= 16) return new Response(null, { status: 429 });
        const current = state ?? { generation: crypto.randomUUID() };
        await tx.put("state", current);
        await tx.put(key, { generation: current.generation, expiresAt: expiresAt! } satisfies Candidate);
        await tx.setAlarm(Math.min(expiresAt!, ...[...candidates.values()].map(c => c.expiresAt)));
        return Response.json({});
      }
      if (action === "/activate") {
        if (!Number.isSafeInteger(expiresAt) || expiresAt! <= now || expiresAt! > now + REFRESH_TTL_SECONDS * 1000) return new Response(null, { status: 400 });
        // A lost activation reply can be retried, but can never extend expiry.
        if (state?.active && state.active.authorizationId === authorizationId && state.active.grantId === grantId && state.active.expiresAt > now) return Response.json({});
        const pending = await tx.get<Candidate>(key);
        if (!state || !pending || pending.expiresAt <= now || pending.generation !== state.generation) return new Response(null, { status: 409 });
        await tx.put("state", { generation: crypto.randomUUID(), active: { authorizationId: authorizationId!, grantId: grantId!, expiresAt: expiresAt! } } satisfies RecordState);
        await tx.delete(key);
        return Response.json({});
      }
      return new Response(null, { status: 404 });
    });
  }
  async alarm() {
    await this.state.storage.transaction(async tx => {
      const pending = await tx.list<Candidate>({ prefix: "pending:" });
      let next = Infinity;
      for (const [key, value] of pending) {
        if (value.expiresAt <= Date.now()) await tx.delete(key);
        else next = Math.min(next, value.expiresAt);
      }
      if (Number.isFinite(next)) await tx.setAlarm(next);
      // state (including expired active identity) intentionally remains a tombstone.
    });
  }
}

export class GrantUnavailable extends Error { constructor() { super("Authorization storage temporarily unavailable"); } }
export class GrantInactive extends Error { constructor() { super("Authorization inactive; reconnect"); } }
export interface GrantScope { userId: string; clientId: string }
export interface GrantIdentity extends GrantScope { authorizationId: string; grantId: string }
async function operation(env: WorkerEnv, scope: GrantScope, action: string, input: object) {
  let response: Response;
  try {
    if (!env.OAUTH_GRANTS) throw new Error();
    const ns = env.OAUTH_GRANTS;
    response = await ns.get(ns.idFromName(JSON.stringify([scope.userId, scope.clientId]))).fetch(`https://grants.internal/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
  } catch { throw new GrantUnavailable(); }
  if (response.status === 401 || response.status === 409) throw new GrantInactive();
  if (!response.ok) throw new GrantUnavailable();
}
export const beginGrant = (env: WorkerEnv, scope: GrantScope, authorizationId: string) => operation(env, scope, "begin", { authorizationId, expiresAt: Date.now() + PENDING_MS });
export const activateGrant = (env: WorkerEnv, identity: GrantIdentity, expiresAt: number) => operation(env, identity, "activate", { ...identity, expiresAt });
export const checkGrant = (env: WorkerEnv, identity: GrantIdentity) => operation(env, identity, "check", identity);
export const revokeGrant = (env: WorkerEnv, scope: GrantScope & { grantId: string }) => operation(env, scope, "revoke", { grantId: scope.grantId });
