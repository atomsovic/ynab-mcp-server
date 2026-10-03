import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizationCodeGate } from "../worker/oauth-code.js";
import { oauthFixture } from "./helpers/oauth.js";

const id = "a".repeat(64);
afterEach(() => vi.useRealTimers());

describe("atomic authorization code gate", () => {
  it("allows exactly one concurrent redemption and rejects a later replay", async () => {
    const { env } = oauthFixture();
    await authorizationCodeGate(env, id, "create");
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => authorizationCodeGate(env, id, "consume")));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await expect(authorizationCodeGate(env, id, "consume")).rejects.toThrow();
  });
  it("enforces expiry even when cleanup has not run", async () => {
    vi.useFakeTimers();
    const { env } = oauthFixture();
    await authorizationCodeGate(env, id, "create");
    vi.advanceTimersByTime(600001);
    await expect(authorizationCodeGate(env, id, "consume")).rejects.toThrow();
  });
  it("fails closed for missing state, invalid IDs, and unavailable storage", async () => {
    const { env } = oauthFixture();
    await expect(authorizationCodeGate(env, id, "consume")).rejects.toThrow();
    await expect(authorizationCodeGate(env, "forged", "create")).rejects.toThrow();
    env.OAUTH_FLOWS = { idFromName: () => id, get: () => ({ fetch: async () => new Response(null, { status: 503 }) }) } as unknown as DurableObjectNamespace;
    await expect(authorizationCodeGate(env, id, "create")).rejects.toThrow();
    await expect(authorizationCodeGate(env, id, "consume")).rejects.toThrow();
  });
});
