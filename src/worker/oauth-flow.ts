import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

export interface PendingFlow {
  authRequest: AuthRequest;
  browserHash: string;
  csrfHash: string;
  expiresAt: number;
  stage: "consent" | "approved";
  allowedPlanId: string;
  mode: string;
  origin: string;
}

/** One Durable Object per random login flow. Only the Worker binding can call it. */
export class OAuthFlowStore {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const action = new URL(request.url).pathname;
    const input = await request.json() as { flow?: PendingFlow; browserHash?: string; csrfHash?: string; expiresAt?: number };
    return this.state.storage.transaction(async tx => {
      if (action === "/create-code" || action === "/consume-code") {
        const code = await tx.get<{ expiresAt: number }>("code");
        if (action === "/create-code") {
          if (code || typeof input.expiresAt !== "number" || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 600000) return new Response(null, { status: 400 });
          await tx.put("code", { expiresAt: input.expiresAt });
          await tx.setAlarm(input.expiresAt);
        } else {
          if (!code || code.expiresAt <= Date.now()) return new Response(null, { status: 400 });
          await tx.delete("code");
        }
        return Response.json({});
      }
      const existing = await tx.get<PendingFlow>("flow");
      if (action === "/create") {
        if (existing || !input.flow || input.flow.stage !== "consent" || input.flow.expiresAt <= Date.now() || input.flow.expiresAt > Date.now() + 600000) return new Response(null, { status: 400 });
        await tx.put("flow", input.flow);
        await tx.setAlarm(input.flow.expiresAt);
        return Response.json({});
      }
      if (!existing || existing.expiresAt <= Date.now() || existing.browserHash !== input.browserHash) return new Response(null, { status: 400 });
      if (action === "/approve" || action === "/deny") {
        if (existing.stage !== "consent" || existing.csrfHash !== input.csrfHash) return new Response(null, { status: 400 });
        if (action === "/deny") await tx.delete("flow");
        else await tx.put("flow", { ...existing, stage: "approved" });
        return Response.json(existing);
      }
      if (action === "/consume" && existing.stage === "approved") {
        await tx.delete("flow");
        return Response.json(existing);
      }
      return new Response(null, { status: 400 });
    });
  }
  async alarm() { await this.state.storage.deleteAll(); }
}
