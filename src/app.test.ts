import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  ApiPolicyDecisionClient,
  StaticAllowPolicyDecisionClient,
  type Decision,
  type PolicyDecisionClient,
} from "./auth/policy.js";
import {
  ApiSessionVerifier,
  AuthUnavailableError,
  extractSessionCookie,
  type Session,
  type SessionVerifier,
} from "./auth/session.js";
import { makeChatDeps, SPEC } from "./chat/test-support.js";
import { loadConfig } from "./config.js";
import { providerOf } from "./models/admin-routes.js";
import type { ModelSpec } from "./models/types.js";

const env = { DATABASE_URL: "postgres://x/y" };

const ORIGIN = "https://ai.ivrm.jp";
const COOKIE = "ivrm_admin_session=abc";

const session: Session = {
  userId: "u1",
  discordUserId: "d1",
  username: "alice",
  roles: ["member"],
  isAdmin: false,
  cookie: COOKIE,
};

function appWith(opts: {
  verify?: SessionVerifier["verify"];
  decision?: Decision;
  specs?: ModelSpec[];
}) {
  const verifier: SessionVerifier = {
    verify: opts.verify ?? vi.fn().mockResolvedValue(session),
  };
  const authorize = vi
    .fn()
    .mockResolvedValue(opts.decision ?? { allowed: true });
  const policy: PolicyDecisionClient = { authorize };
  return {
    authorize,
    app: createApp({
      auth: { verifier, policy, allowedOrigin: ORIGIN },
      chat: makeChatDeps({
        policy,
        ...(opts.specs ? { specs: opts.specs } : {}),
      }).deps,
    }),
  };
}

describe("health", () => {
  it("is public", async () => {
    const res = await appWith({}).app.request("/healthz");
    expect(res.status).toBe(200);
  });
});

describe("access control", () => {
  it("401 without a valid session", async () => {
    const { app, authorize } = appWith({ verify: async () => null });
    const res = await app.request("/api/me");
    expect(res.status).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("403 when the policy denies", async () => {
    const { app } = appWith({ decision: { allowed: false, reason: "denied" } });
    expect((await app.request("/api/me")).status).toBe(403);
  });

  it("503 when no decision can be made (fail closed)", async () => {
    const { app } = appWith({
      decision: { allowed: false, reason: "decision_unavailable" },
    });
    expect((await app.request("/api/me")).status).toBe(503);
  });

  it("503 when the session check is unavailable", async () => {
    const { app, authorize } = appWith({
      verify: async () => {
        throw new AuthUnavailableError("down");
      },
    });
    expect((await app.request("/api/me")).status).toBe(503);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("200 for an allowed member, and asks for ai:Use", async () => {
    const { app, authorize } = appWith({});
    const res = await app.request("/api/me", { headers: { cookie: COOKIE } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: "u1", username: "alice", isAdmin: false },
    });
    expect(authorize).toHaveBeenCalledWith(session, {
      action: "ai:Use",
      resource: "ivrm:ai:*",
    });
  });

  it("rejects state-changing requests from another origin", async () => {
    const { app } = appWith({});
    const evil = await app.request("/api/me", {
      method: "POST",
      headers: { origin: "https://member.ivrm.jp" },
    });
    expect(evil.status).toBe(403);
    const none = await app.request("/api/me", { method: "POST" });
    expect(none.status).toBe(403);
  });

  it("lets a state-changing request from the allowed origin reach the route", async () => {
    const { app } = appWith({});
    const res = await app.request("/api/me", {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    // Passed the origin check; there is no POST route, so Hono answers 404.
    expect(res.status).toBe(404);
  });
});

describe("GET /api/admin/models", () => {
  const specs: ModelSpec[] = [
    {
      ...SPEC,
      id: "gpt",
      label: "GPT",
      bedrockModelId: "openai.gpt-oss-120b-1:0",
    },
    {
      ...SPEC,
      id: "haiku",
      label: "Haiku",
      bedrockModelId: "jp.anthropic.claude-haiku-5-5",
      pricing: null,
    },
  ];
  const admin = { ...session, isAdmin: true, roles: ["admin"] };

  it("lists the whole catalog for an admin, without prices or Bedrock ids", async () => {
    const { app } = appWith({ verify: async () => admin, specs });
    const res = await app.request("/api/admin/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      models: [
        { id: "gpt", label: "GPT", provider: "OpenAI", callable: true },
        { id: "haiku", label: "Haiku", provider: "Anthropic", callable: false },
      ],
    });
  });

  it("403 for a member who may use ai but is not an admin", async () => {
    const { app } = appWith({ specs });
    expect((await app.request("/api/admin/models")).status).toBe(403);
  });

  it("401 without a session", async () => {
    const { app } = appWith({ verify: async () => null, specs });
    expect((await app.request("/api/admin/models")).status).toBe(401);
  });
});

describe("providerOf", () => {
  it.each([
    ["openai.gpt-oss-120b-1:0", "OpenAI"],
    ["deepseek.v3-v1:0", "DeepSeek"],
    ["global.anthropic.claude-sonnet-5-5", "Anthropic"],
    ["jp.anthropic.claude-haiku-5-5", "Anthropic"],
  ])("%s -> %s", (bedrockModelId, provider) => {
    expect(providerOf({ bedrockModelId })).toBe(provider);
  });
});

describe("extractSessionCookie", () => {
  it("keeps only the session cookie", () => {
    expect(extractSessionCookie("a=1; ivrm_admin_session=abc; b=2")).toBe(
      COOKIE
    );
  });

  it("returns null when absent or empty", () => {
    expect(extractSessionCookie(undefined)).toBeNull();
    expect(extractSessionCookie("a=1")).toBeNull();
    expect(extractSessionCookie("ivrm_admin_session=")).toBeNull();
  });
});

const meBody = {
  user: { id: "u1", discordUserId: "d1", username: "alice", avatar: null },
  roles: ["member"],
  permissions: [],
  isAdmin: false,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("ApiSessionVerifier", () => {
  it("forwards only the session cookie and parses the session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(meBody));
    const verifier = new ApiSessionVerifier("https://api.test", fetchImpl);
    const result = await verifier.verify("x=1; ivrm_admin_session=abc");
    expect(result).toMatchObject({ userId: "u1", cookie: COOKIE });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/auth/me");
    expect(init.headers.cookie).toBe(COOKIE);
  });

  it("does not call the API without a session cookie", async () => {
    const fetchImpl = vi.fn();
    const verifier = new ApiSessionVerifier("https://api.test", fetchImpl);
    expect(await verifier.verify("x=1")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats 401 and 403 as no session", async () => {
    for (const status of [401, 403]) {
      const verifier = new ApiSessionVerifier(
        "https://api.test",
        vi.fn().mockResolvedValue(jsonResponse({}, status))
      );
      expect(await verifier.verify(COOKIE)).toBeNull();
    }
  });

  it("is unavailable on 5xx, network errors and bad bodies", async () => {
    const cases = [
      vi.fn().mockResolvedValue(jsonResponse({}, 502)),
      vi.fn().mockRejectedValue(new Error("network")),
      vi.fn().mockResolvedValue(jsonResponse({ nope: true })),
    ];
    for (const fetchImpl of cases) {
      const verifier = new ApiSessionVerifier("https://api.test", fetchImpl);
      await expect(verifier.verify(COOKIE)).rejects.toBeInstanceOf(
        AuthUnavailableError
      );
    }
  });
});

describe("ApiPolicyDecisionClient", () => {
  const query = { action: "ai:Use", resource: "ivrm:ai:*" };

  it("posts the query with the user's cookie and honours an allow", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ allowed: true }));
    const client = new ApiPolicyDecisionClient("https://api.test", fetchImpl);
    expect(await client.authorize(session, query)).toEqual({ allowed: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/auth/authorize");
    expect(init.headers.cookie).toBe(COOKIE);
    expect(JSON.parse(init.body)).toEqual(query);
  });

  it("denies on an explicit deny", async () => {
    const client = new ApiPolicyDecisionClient(
      "https://api.test",
      vi.fn().mockResolvedValue(jsonResponse({ allowed: false }))
    );
    expect(await client.authorize(session, query)).toEqual({
      allowed: false,
      reason: "denied",
    });
  });

  it("denies as unavailable while the endpoint does not exist (404)", async () => {
    const client = new ApiPolicyDecisionClient(
      "https://api.test",
      vi.fn().mockResolvedValue(jsonResponse({}, 404))
    );
    expect(await client.authorize(session, query)).toEqual({
      allowed: false,
      reason: "decision_unavailable",
    });
  });

  it("denies on network errors and malformed bodies", async () => {
    for (const fetchImpl of [
      vi.fn().mockRejectedValue(new Error("network")),
      vi.fn().mockResolvedValue(jsonResponse({ allowed: "yes" })),
    ]) {
      const client = new ApiPolicyDecisionClient("https://api.test", fetchImpl);
      expect(await client.authorize(session, query)).toMatchObject({
        allowed: false,
      });
    }
  });
});

describe("StaticAllowPolicyDecisionClient", () => {
  it("allows", async () => {
    expect(await new StaticAllowPolicyDecisionClient().authorize()).toEqual({
      allowed: true,
    });
  });
});

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    const config = loadConfig(env);
    expect(config.PORT).toBe(3100);
    expect(config.AI_KILL_SWITCH).toBe(false);
    expect(config.AI_POLICY_MODE).toBe("api");
  });

  it("rejects an invalid kill switch value", () => {
    expect(() => loadConfig({ ...env, AI_KILL_SWITCH: "yes" })).toThrow();
  });

  it("refuses the static policy in production", () => {
    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: "production",
        AI_POLICY_MODE: "static-allow",
      })
    ).toThrow();
    expect(
      loadConfig({
        ...env,
        NODE_ENV: "development",
        AI_POLICY_MODE: "static-allow",
      }).AI_POLICY_MODE
    ).toBe("static-allow");
  });
});
