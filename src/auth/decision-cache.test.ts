import { describe, expect, it, vi } from "vitest";
import {
  CachedPolicyDecisionClient,
  DECISION_CACHE_TTL_MS,
} from "./decision-cache.js";
import type { Decision, PolicyDecisionClient } from "./policy.js";
import type { Session } from "./session.js";

const session = (userId: string): Session => ({
  userId,
  discordUserId: `d-${userId}`,
  username: userId,
  roles: ["member"],
  isAdmin: false,
  cookie: `ivrm_admin_session=${userId}`,
});

const USE = { action: "ai:Use", resource: "ivrm:ai:*" };

function setup(responder: () => Promise<Decision> | Decision) {
  let clock = 1_000;
  const authorize = vi.fn(async () => responder());
  const inner: PolicyDecisionClient = { authorize };
  const client = new CachedPolicyDecisionClient(inner, { now: () => clock });
  return {
    client,
    authorize,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("CachedPolicyDecisionClient", () => {
  it("reuses an allowed decision until the ttl, then asks again", async () => {
    const { client, authorize, advance } = setup(() => ({ allowed: true }));
    expect(await client.authorize(session("a"), USE)).toEqual({
      allowed: true,
    });
    advance(DECISION_CACHE_TTL_MS - 1);
    await client.authorize(session("a"), USE);
    expect(authorize).toHaveBeenCalledTimes(1);
    advance(2);
    await client.authorize(session("a"), USE);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("also reuses an explicit denial", async () => {
    const { client, authorize } = setup(() => ({
      allowed: false,
      reason: "denied",
    }));
    const first = await client.authorize(session("a"), USE);
    const second = await client.authorize(session("a"), USE);
    expect(first).toEqual({ allowed: false, reason: "denied" });
    expect(second).toEqual(first);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("never keeps a failure to decide", async () => {
    const { client, authorize } = setup(() => ({
      allowed: false,
      reason: "decision_unavailable",
    }));
    await client.authorize(session("a"), USE);
    await client.authorize(session("a"), USE);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("never keeps a thrown error, and a later success is used", async () => {
    let fail = true;
    const { client, authorize } = setup(() => {
      if (fail) throw new Error("boom");
      return { allowed: true };
    });
    await expect(client.authorize(session("a"), USE)).rejects.toThrow("boom");
    fail = false;
    expect(await client.authorize(session("a"), USE)).toEqual({
      allowed: true,
    });
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("does not share decisions across users, actions or resources", async () => {
    const { client, authorize } = setup(() => ({ allowed: true }));
    await client.authorize(session("a"), USE);
    await client.authorize(session("b"), USE);
    await client.authorize(session("a"), { ...USE, action: "ai:UseModel" });
    await client.authorize(session("a"), {
      ...USE,
      resource: "ivrm:ai:model/m1",
    });
    expect(authorize).toHaveBeenCalledTimes(4);
  });

  it("does not let a user inherit someone else's allow", async () => {
    const decisions: Record<string, Decision> = {
      a: { allowed: true },
      b: { allowed: false, reason: "denied" },
    };
    let current = "a";
    const { client } = setup(() => decisions[current]!);
    expect(await client.authorize(session("a"), USE)).toEqual({
      allowed: true,
    });
    current = "b";
    expect(await client.authorize(session("b"), USE)).toEqual({
      allowed: false,
      reason: "denied",
    });
  });

  it("shares one call between identical requests in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client, authorize } = setup(async () => {
      await gate;
      return { allowed: true };
    });
    const first = client.authorize(session("a"), USE);
    const second = client.authorize(session("a"), USE);
    release();
    expect(await first).toEqual({ allowed: true });
    expect(await second).toEqual({ allowed: true });
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("bounds its size by dropping the oldest entries", async () => {
    let clock = 0;
    const authorize = vi.fn(async () => ({ allowed: true }) as Decision);
    const client = new CachedPolicyDecisionClient(
      { authorize },
      { maxEntries: 2, now: () => clock }
    );
    await client.authorize(session("a"), USE);
    await client.authorize(session("b"), USE);
    await client.authorize(session("c"), USE); // evicts a
    expect(authorize).toHaveBeenCalledTimes(3);
    await client.authorize(session("b"), USE);
    await client.authorize(session("c"), USE);
    expect(authorize).toHaveBeenCalledTimes(3); // still cached
    await client.authorize(session("a"), USE);
    expect(authorize).toHaveBeenCalledTimes(4); // was evicted
    clock += 1; // keep the linter honest about the injected clock
  });
});
