import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { PolicyDecisionClient } from "../auth/policy.js";
import type { Session, SessionVerifier } from "../auth/session.js";
import {
  ModelError,
  type ChatModel,
  type StreamEvent,
} from "../models/types.js";
import { toChatMessages, MAX_TEXT_CHARS } from "./routes.js";
import {
  SPEC,
  makeChatDeps,
  scriptedModel,
  type RecordingAudit,
} from "./test-support.js";

const ORIGIN = "https://ai.ivrm.jp";

function sessionFor(userId: string): Session {
  return {
    userId,
    discordUserId: `d-${userId}`,
    username: userId,
    roles: ["member"],
    isAdmin: false,
    cookie: `ivrm_admin_session=${userId}`,
  };
}

// The cookie value is the user id, so tests can act as different users.
const verifier: SessionVerifier = {
  verify: async (cookie) => {
    const match = cookie?.match(/ivrm_admin_session=(\w+)/);
    return match ? sessionFor(match[1]!) : null;
  },
};

function setup(opts: Parameters<typeof makeChatDeps>[0] = {}) {
  const ctx = makeChatDeps(opts);
  const policy = opts.policy ?? { authorize: async () => ({ allowed: true }) };
  const app = createApp({
    auth: {
      verifier,
      policy: { authorize: async () => ({ allowed: true }) },
      allowedOrigin: ORIGIN,
    },
    chat: ctx.deps,
  });

  async function call(
    user: string,
    method: string,
    path: string,
    body?: unknown
  ) {
    return app.request(`/api${path}`, {
      method,
      headers: {
        cookie: `ivrm_admin_session=${user}`,
        origin: ORIGIN,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function conversation(user = "alice", extra: object = {}) {
    const res = await call(user, "POST", "/conversations", {
      modelId: "m1",
      ...extra,
    });
    return (await res.json()).conversation as { id: string };
  }

  return { ...ctx, app, call, conversation, policy };
}

function parseSse(text: string) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : undefined };
    });
}

describe("GET /models", () => {
  it("lists only models that are priced and allowed", async () => {
    const deny: PolicyDecisionClient = {
      authorize: async (_s, q) =>
        q.resource.endsWith("/blocked")
          ? { allowed: false, reason: "denied" }
          : { allowed: true },
    };
    const { deps } = makeChatDeps({
      policy: deny,
      specs: [
        SPEC,
        { ...SPEC, id: "blocked" },
        { ...SPEC, id: "unpriced", pricing: null },
      ],
    });
    const app = createApp({
      auth: {
        verifier,
        policy: { authorize: async () => ({ allowed: true }) },
        allowedOrigin: ORIGIN,
      },
      chat: deps,
    });
    const res = await app.request("/api/models", {
      headers: { cookie: "ivrm_admin_session=alice" },
    });
    const body = await res.json();
    expect(body.models.map((m: { id: string }) => m.id)).toEqual(["m1"]);
  });
});

describe("projects", () => {
  it("creates, lists, edits and archives; hides them from others", async () => {
    const { call } = setup();
    const created = await call("alice", "POST", "/projects", {
      name: "Docs",
      instructions: "answer in Japanese",
    });
    expect(created.status).toBe(201);
    const id = (await created.json()).project.id as string;

    const list = await (await call("alice", "GET", "/projects")).json();
    expect(list.projects).toHaveLength(1);

    const patched = await call("alice", "PATCH", `/projects/${id}`, {
      name: "Docs 2",
    });
    expect((await patched.json()).project).toMatchObject({
      name: "Docs 2",
      instructions: "answer in Japanese",
    });

    expect((await call("bob", "GET", `/projects/${id}`)).status).toBe(404);
    expect(
      (await call("bob", "PATCH", `/projects/${id}`, { name: "x" })).status
    ).toBe(404);
    expect((await call("bob", "POST", `/projects/${id}/archive`)).status).toBe(
      404
    );

    await call("alice", "POST", `/projects/${id}/archive`);
    expect(
      (await (await call("alice", "GET", "/projects")).json()).projects
    ).toEqual([]);
    const archived = await (
      await call("alice", "GET", "/projects?archived=true")
    ).json();
    expect(archived.projects).toHaveLength(1);
    await call("alice", "POST", `/projects/${id}/unarchive`);
    expect(
      (await (await call("alice", "GET", "/projects")).json()).projects
    ).toHaveLength(1);
  });

  it("rejects invalid bodies", async () => {
    const { call } = setup();
    expect(
      (await call("alice", "POST", "/projects", { name: "" })).status
    ).toBe(400);
    expect((await call("alice", "POST", "/projects", {})).status).toBe(400);
    const p = await (
      await call("alice", "POST", "/projects", { name: "x" })
    ).json();
    expect(
      (await call("alice", "PATCH", `/projects/${p.project.id}`, {})).status
    ).toBe(400);
  });
});

describe("conversations", () => {
  it("creates, archives and lists; hides them from others", async () => {
    const { call, conversation } = setup();
    const c = await conversation();
    expect((await call("bob", "GET", `/conversations/${c.id}`)).status).toBe(
      404
    );
    expect(
      (await call("bob", "POST", `/conversations/${c.id}/archive`)).status
    ).toBe(404);

    await call("alice", "POST", `/conversations/${c.id}/archive`);
    expect(
      (await (await call("alice", "GET", "/conversations")).json())
        .conversations
    ).toEqual([]);
    const archived = await (
      await call("alice", "GET", "/conversations?archived=true")
    ).json();
    expect(archived.conversations).toHaveLength(1);
  });

  it("rejects an unknown or unpriced model", async () => {
    const { call } = setup({
      specs: [SPEC, { ...SPEC, id: "u", pricing: null }],
    });
    expect(
      (await call("alice", "POST", "/conversations", { modelId: "nope" }))
        .status
    ).toBe(400);
    expect(
      (await call("alice", "POST", "/conversations", { modelId: "u" })).status
    ).toBe(503);
  });

  it("rejects a model the policy denies", async () => {
    const { call } = setup({
      policy: { authorize: async () => ({ allowed: false, reason: "denied" }) },
    });
    const res = await call("alice", "POST", "/conversations", {
      modelId: "m1",
    });
    expect(res.status).toBe(403);
  });

  it("rejects a project that is not the user's", async () => {
    const { call } = setup();
    const p = await (
      await call("bob", "POST", "/projects", { name: "B" })
    ).json();
    const res = await call("alice", "POST", "/conversations", {
      modelId: "m1",
      projectId: p.project.id,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /conversations/:id/messages", () => {
  it("streams the answer, saves both messages, titles and audits", async () => {
    const { call, conversation, audit, model } = setup();
    const p = await (
      await call("alice", "POST", "/projects", {
        name: "P",
        instructions: "be brief",
      })
    ).json();
    const c = await conversation("alice", { projectId: p.project.id });

    const res = await call("alice", "POST", `/conversations/${c.id}/messages`, {
      text: "hello there",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(["delta", "delta", "done"]);
    expect(events[0]!.data).toEqual({ text: "he" });
    expect(events[2]!.data).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 20 },
      costMicroUsd: 50, // 10 * 1 + 20 * 2
      stopReason: "end_turn",
    });

    const view = await (
      await call("alice", "GET", `/conversations/${c.id}`)
    ).json();
    expect(view.conversation.title).toBe("hello there");
    expect(
      view.messages.map((m: { role: string; content: string }) => [
        m.role,
        m.content,
      ])
    ).toEqual([
      ["user", "hello there"],
      ["assistant", "hello"],
    ]);

    const sent = (model as ReturnType<typeof scriptedModel>).requests[0]!;
    expect(sent.system).toBe("be brief");
    expect(sent.messages).toEqual([{ role: "user", text: "hello there" }]);

    const entry = (audit as RecordingAudit).entries.find(
      (e) => e.action === "chat.message"
    );
    expect(entry).toMatchObject({
      actorId: "alice",
      resource: `conversation/${c.id}`,
      detail: { model: "m1", costMicroUsd: 50 },
    });
    // Message bodies never go to the audit log.
    expect(JSON.stringify(entry)).not.toContain("hello");
  });

  it("includes earlier turns in the next request", async () => {
    const { call, conversation, model } = setup();
    const c = await conversation();
    await (
      await call("alice", "POST", `/conversations/${c.id}/messages`, {
        text: "one",
      })
    ).text();
    await (
      await call("alice", "POST", `/conversations/${c.id}/messages`, {
        text: "two",
      })
    ).text();
    const second = (model as ReturnType<typeof scriptedModel>).requests[1]!;
    expect(second.messages.map((m) => m.text)).toEqual(["one", "hello", "two"]);
  });

  it("returns 404 for another user's conversation without calling the model", async () => {
    const { call, conversation, model } = setup();
    const c = await conversation("alice");
    const res = await call("bob", "POST", `/conversations/${c.id}/messages`, {
      text: "hi",
    });
    expect(res.status).toBe(404);
    expect((model as ReturnType<typeof scriptedModel>).requests).toHaveLength(
      0
    );
  });

  it("rejects empty and oversized text", async () => {
    const { call, conversation } = setup();
    const c = await conversation();
    const path = `/conversations/${c.id}/messages`;
    expect((await call("alice", "POST", path, { text: "  " })).status).toBe(
      400
    );
    expect(
      (
        await call("alice", "POST", path, {
          text: "x".repeat(MAX_TEXT_CHARS + 1),
        })
      ).status
    ).toBe(400);
    expect((await call("alice", "POST", path, {})).status).toBe(400);
  });

  it("returns 403 when the policy denies the model", async () => {
    let allowModel = true;
    const { call, conversation, model } = setup({
      policy: {
        authorize: async (_s, q) =>
          q.action === "ai:UseModel" && !allowModel
            ? { allowed: false, reason: "denied" }
            : { allowed: true },
      },
    });
    const c = await conversation();
    allowModel = false;
    const res = await call("alice", "POST", `/conversations/${c.id}/messages`, {
      text: "hi",
    });
    expect(res.status).toBe(403);
    expect((model as ReturnType<typeof scriptedModel>).requests).toHaveLength(
      0
    );
  });

  describe("cost gate refusals are plain HTTP errors and save nothing", () => {
    const cases: [string, Parameters<typeof makeChatDeps>[0], number][] = [
      ["kill switch", { killSwitch: true }, 503],
      ["request too large", { limits: { perRequestMicroUsd: 1 } }, 413],
      ["user daily limit", { limits: { userDailyMicroUsd: 1 } }, 429],
      ["rate limit", { limits: { userRequestsPerMinute: 0 } }, 429],
    ];
    for (const [name, opts, status] of cases) {
      it(`${name} -> ${status}`, async () => {
        const { call, conversation, model } = setup(opts);
        const c = await conversation();
        const res = await call(
          "alice",
          "POST",
          `/conversations/${c.id}/messages`,
          { text: "hi" }
        );
        expect(res.status).toBe(status);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(
          (model as ReturnType<typeof scriptedModel>).requests
        ).toHaveLength(0);
        const view = await (
          await call("alice", "GET", `/conversations/${c.id}`)
        ).json();
        expect(view.messages).toEqual([]);
      });
    }

    it("sets Retry-After for the rate limit", async () => {
      const { call, conversation } = setup({
        limits: { userRequestsPerMinute: 0 },
      });
      const c = await conversation();
      const res = await call(
        "alice",
        "POST",
        `/conversations/${c.id}/messages`,
        { text: "hi" }
      );
      expect(res.headers.get("retry-after")).toBe("60");
      expect((await res.json()).reason).toBe("rate");
    });
  });

  it("sends an error event and saves no answer when the stream fails midway", async () => {
    const failing: ChatModel = {
      generate: vi.fn(),
      stream: async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text", text: "par" };
        throw new Error("boom");
      },
    };
    const { call, conversation } = setup({ model: failing });
    const c = await conversation();
    const res = await call("alice", "POST", `/conversations/${c.id}/messages`, {
      text: "hi",
    });
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(["delta", "error"]);
    expect(events[1]!.data).toEqual({ code: "internal_error" });

    const view = await (
      await call("alice", "GET", `/conversations/${c.id}`)
    ).json();
    expect(view.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
    ]);
  });

  it("recovers on the next turn after a failed answer (no consecutive user turns)", async () => {
    let fail = true;
    const seen: unknown[] = [];
    const model: ChatModel = {
      generate: vi.fn(),
      stream: async function* (request): AsyncGenerator<StreamEvent> {
        seen.push(request.messages);
        yield { type: "text", text: "par" };
        if (fail) {
          fail = false;
          throw new Error("boom");
        }
        yield {
          type: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const { call, conversation } = setup({ model });
    const c = await conversation();
    const path = `/conversations/${c.id}/messages`;
    // The answer fails midway: the user turn is saved, the answer is not.
    await (await call("alice", "POST", path, { text: "first" })).text();
    const second = await (
      await call("alice", "POST", path, { text: "second" })
    ).text();
    expect(second).toContain("event: done");
    expect(seen[1]).toEqual([{ role: "user", text: "first\n\nsecond" }]);
  });

  it("maps a provider failure before the first token to 502", async () => {
    const failing: ChatModel = {
      generate: vi.fn(),
      // eslint-disable-next-line require-yield
      stream: async function* (): AsyncGenerator<StreamEvent> {
        throw new ModelError("provider_error", "x");
      },
    };
    const { call, conversation } = setup({ model: failing });
    const c = await conversation();
    const res = await call("alice", "POST", `/conversations/${c.id}/messages`, {
      text: "hi",
    });
    expect(res.status).toBe(502);
    const view = await (
      await call("alice", "GET", `/conversations/${c.id}`)
    ).json();
    expect(view.messages).toEqual([]);
  });
});

describe("toChatMessages", () => {
  const m = (role: "user" | "assistant", content: string) => ({
    id: "i",
    role,
    content,
    modelId: null,
    createdAt: "t",
  });

  it("alternates roles and ends with the new user turn", () => {
    expect(toChatMessages([m("user", "a"), m("assistant", "b")], "c")).toEqual([
      { role: "user", text: "a" },
      { role: "assistant", text: "b" },
      { role: "user", text: "c" },
    ]);
  });

  it("merges a user turn left without a reply", () => {
    expect(toChatMessages([m("user", "a")], "b")).toEqual([
      { role: "user", text: "a\n\nb" },
    ]);
  });

  it("drops a leading assistant turn cut by the history window", () => {
    expect(
      toChatMessages(
        [m("assistant", "b"), m("user", "c"), m("assistant", "d")],
        "e"
      )
    ).toEqual([
      { role: "user", text: "c" },
      { role: "assistant", text: "d" },
      { role: "user", text: "e" },
    ]);
  });
});
