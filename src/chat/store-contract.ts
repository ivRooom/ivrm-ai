import { describe, expect, it } from "vitest";
import type { ChatStore } from "./types.js";

const MISSING = "00000000-0000-4000-8000-000000000000";

/** Behaviour every ChatStore must share (in-memory and Postgres). */
export function chatStoreContract(
  name: string,
  make: () => Promise<ChatStore>
) {
  describe(`ChatStore contract: ${name}`, () => {
    it("isolates stored answer usage and never recounts forked history", async () => {
      const store = await make();
      const source = (await store.createConversation("alice", {
        projectId: null,
        title: "source",
        modelId: "m1",
      }))!;
      await store.appendMessage("alice", source.id, {
        role: "assistant",
        content: "complete",
        modelId: "m1",
        inputTokens: 12,
        outputTokens: 8,
        costMicroUsd: 0,
      });
      await store.appendMessage("alice", source.id, {
        role: "assistant",
        content: "no usage",
        modelId: "m1",
      });
      const target = (await store.appendMessage("alice", source.id, {
        role: "user",
        content: "target",
      }))!;
      const result = await store.forkConversation(
        "alice",
        source.id,
        target.id,
        "m1"
      );
      expect(result && "conversation" in result).toBe(true);
      await store.setConversationArchived("alice", source.id, true);
      expect(await store.getUsageBuckets("alice")).toEqual([
        expect.objectContaining({
          modelId: "m1",
          answers: 1,
          tokens: 20,
          maxTokens: 20,
        }),
      ]);
      expect(await store.getUsageBuckets("bob")).toEqual([]);
    });
    it("forks before an owned user message, keeps the source, and uses new ids", async () => {
      const store = await make();
      const source = (await store.createConversation("alice", {
        projectId: null,
        title: "source",
        modelId: "m1",
      }))!;
      const first = (await store.appendMessage("alice", source.id, {
        role: "user",
        content: "first",
      }))!;
      await store.appendMessage("alice", source.id, {
        role: "assistant",
        content: "old answer",
        modelId: "m1",
        inputTokens: 10,
        outputTokens: 20,
        costMicroUsd: 50,
      });
      const target = (await store.appendMessage("alice", source.id, {
        role: "user",
        content: "question",
      }))!;
      await store.appendMessage("alice", source.id, {
        role: "assistant",
        content: "excluded",
      });
      const before = await store.listMessages("alice", source.id, 200);
      const result = await store.forkConversation(
        "alice",
        source.id,
        target.id,
        "m2"
      );
      expect(result && "conversation" in result).toBe(true);
      if (!result || !("conversation" in result)) throw Error("expected fork");
      expect(result.draft).toBe("question");
      expect(result.conversation.modelId).toBe("m2");
      expect(result.conversation.id).not.toBe(source.id);
      const copied = (await store.listMessages(
        "alice",
        result.conversation.id,
        200
      ))!;
      expect(copied.map((m) => m.content)).toEqual(["first", "old answer"]);
      expect(copied[0]!.id).not.toBe(first.id);
      expect(await store.listMessages("alice", source.id, 200)).toEqual(before);
      expect(
        await store.forkConversation("bob", source.id, target.id, "m1")
      ).toBeNull();
      expect(
        await store.listMessages("bob", result.conversation.id, 200)
      ).toBeNull();
      expect(
        await store.forkConversation(
          "alice",
          result.conversation.id,
          target.id,
          "m1"
        )
      ).toBeNull();
      expect(
        await store.forkConversation("alice", source.id, before![1]!.id, "m1")
      ).toBeNull();
    });

    it("refuses archived sources/projects and permits a first-question empty prefix", async () => {
      const store = await make();
      const p = await store.createProject("alice", {
        name: "P",
        instructions: "x",
      });
      const source = (await store.createConversation("alice", {
        projectId: p.id,
        title: "",
        modelId: "m1",
      }))!;
      const question = (await store.appendMessage("alice", source.id, {
        role: "user",
        content: "only",
      }))!;
      const result = await store.forkConversation(
        "alice",
        source.id,
        question.id,
        "m1"
      );
      if (!result || !("conversation" in result)) throw Error("expected fork");
      expect(result.conversation.projectId).toBe(p.id);
      expect(
        await store.listMessages("alice", result.conversation.id, 200)
      ).toEqual([]);
      await store.setConversationArchived("alice", source.id, true);
      expect(
        await store.forkConversation("alice", source.id, question.id, "m1")
      ).toEqual({ error: "conversation_archived" });
      await store.setConversationArchived("alice", source.id, false);
      await store.setProjectArchived("alice", p.id, true);
      expect(
        await store.forkConversation("alice", source.id, question.id, "m1")
      ).toEqual({ error: "project_archived" });
    });

    it("copies exactly 200 prefix messages and refuses 201 without creating a partial conversation", async () => {
      const store = await make();
      const source = (await store.createConversation("alice", {
        projectId: null,
        title: "many",
        modelId: "m1",
      }))!;
      for (let i = 0; i < 200; i++)
        await store.appendMessage("alice", source.id, {
          role: i % 2 ? "assistant" : "user",
          content: String(i),
        });
      const atLimit = (await store.appendMessage("alice", source.id, {
        role: "user",
        content: "target",
      }))!;
      const allowed = await store.forkConversation(
        "alice",
        source.id,
        atLimit.id,
        "m1"
      );
      if (!allowed || !("conversation" in allowed))
        throw Error("expected fork");
      expect(
        (await store.listMessages("alice", allowed.conversation.id, 201))!
          .length
      ).toBe(200);
      const overLimit = (await store.appendMessage("alice", source.id, {
        role: "user",
        content: "over",
      }))!;
      const before = await store.listConversations("alice", {
        archived: false,
      });
      expect(
        await store.forkConversation("alice", source.id, overLimit.id, "m1")
      ).toEqual({ error: "history_too_large" });
      expect(
        await store.listConversations("alice", { archived: false })
      ).toEqual(before);
    });

    it("bounds prefix bytes using UTF-8 rather than character count", async () => {
      const store = await make();
      const source = (await store.createConversation("alice", {
        projectId: null,
        title: "bytes",
        modelId: "m1",
      }))!;
      await store.appendMessage("alice", source.id, {
        role: "user",
        content: "あ".repeat(174762) + "ab",
      });
      const atLimit = (await store.appendMessage("alice", source.id, {
        role: "user",
        content: "x",
      }))!;
      const allowed = await store.forkConversation(
        "alice",
        source.id,
        atLimit.id,
        "m1"
      );
      expect(allowed && "conversation" in allowed).toBe(true);
      const over = (await store.appendMessage("alice", source.id, {
        role: "user",
        content: "y",
      }))!;
      expect(
        await store.forkConversation("alice", source.id, over.id, "m1")
      ).toEqual({ error: "history_too_large" });
    });
    it("renames only the owner's conversation and preserves its messages", async () => {
      const store = await make();
      const c = (await store.createConversation("alice", {
        projectId: null,
        title: "old",
        modelId: "m1",
      }))!;
      await store.appendMessage("alice", c.id, {
        role: "user",
        content: "keep",
      });
      expect(await store.renameConversation("bob", c.id, "hijack")).toBeNull();
      expect(
        await store.renameConversation("alice", "invalid", "bad")
      ).toBeNull();
      expect(
        await store.renameConversation("alice", c.id, "新しいタイトル")
      ).toMatchObject({ title: "新しいタイトル", modelId: "m1" });
      await store.setTitleIfEmpty("alice", c.id, "automatic");
      expect((await store.getConversation("alice", c.id))?.title).toBe(
        "新しいタイトル"
      );
      expect((await store.listMessages("alice", c.id, 200))?.[0]?.content).toBe(
        "keep"
      );
    });
    it("creates and reads a project, only for its owner", async () => {
      const store = await make();
      const project = await store.createProject("alice", {
        name: "P",
        instructions: "be brief",
      });
      expect(await store.getProject("alice", project.id)).toMatchObject({
        name: "P",
        instructions: "be brief",
        archived: false,
      });
      expect(await store.getProject("bob", project.id)).toBeNull();
      expect(await store.getProject("alice", MISSING)).toBeNull();
      expect(await store.getProject("alice", "not-a-uuid")).toBeNull();
    });

    it("updates a project partially and only for its owner", async () => {
      const store = await make();
      const p = await store.createProject("alice", {
        name: "P",
        instructions: "x",
      });
      expect(
        await store.updateProject("alice", p.id, { name: "Q" })
      ).toMatchObject({ name: "Q", instructions: "x" });
      expect(await store.updateProject("bob", p.id, { name: "Z" })).toBeNull();
      expect((await store.getProject("alice", p.id))?.name).toBe("Q");
    });

    it("archives and restores projects, listing each side separately", async () => {
      const store = await make();
      const a = await store.createProject("alice", {
        name: "A",
        instructions: "",
      });
      await store.createProject("alice", { name: "B", instructions: "" });
      await store.setProjectArchived("alice", a.id, true);
      expect(
        (await store.listProjects("alice", { archived: true })).map(
          (p) => p.name
        )
      ).toEqual(["A"]);
      expect(
        (await store.listProjects("alice", { archived: false })).map(
          (p) => p.name
        )
      ).toEqual(["B"]);
      await store.setProjectArchived("alice", a.id, false);
      expect(await store.listProjects("alice", { archived: true })).toEqual([]);
      expect(await store.setProjectArchived("bob", a.id, true)).toBeNull();
    });

    it("does not list another user's projects", async () => {
      const store = await make();
      await store.createProject("alice", { name: "A", instructions: "" });
      expect(await store.listProjects("bob", { archived: false })).toEqual([]);
    });

    it("creates a conversation, in a project only if the owner has it", async () => {
      const store = await make();
      const project = await store.createProject("alice", {
        name: "P",
        instructions: "",
      });
      const inProject = await store.createConversation("alice", {
        projectId: project.id,
        title: "",
        modelId: "m1",
      });
      expect(inProject).toMatchObject({ projectId: project.id, modelId: "m1" });
      expect(
        await store.createConversation("bob", {
          projectId: project.id,
          title: "",
          modelId: "m1",
        })
      ).toBeNull();
      expect(
        await store.createConversation("alice", {
          projectId: MISSING,
          title: "",
          modelId: "m1",
        })
      ).toBeNull();
    });

    it("hides a conversation from other users", async () => {
      const store = await make();
      const c = await store.createConversation("alice", {
        projectId: null,
        title: "T",
        modelId: "m1",
      });
      const id = c!.id;
      expect(await store.getConversation("bob", id)).toBeNull();
      expect(await store.setConversationArchived("bob", id, true)).toBeNull();
      expect(await store.listMessages("bob", id, 10)).toBeNull();
      expect(
        await store.appendMessage("bob", id, { role: "user", content: "hi" })
      ).toBeNull();
      expect(await store.listConversations("bob", { archived: false })).toEqual(
        []
      );
    });

    it("archives conversations and filters by project", async () => {
      const store = await make();
      const p = await store.createProject("alice", {
        name: "P",
        instructions: "",
      });
      const inP = await store.createConversation("alice", {
        projectId: p.id,
        title: "in",
        modelId: "m1",
      });
      await store.createConversation("alice", {
        projectId: null,
        title: "out",
        modelId: "m1",
      });
      expect(
        (
          await store.listConversations("alice", {
            archived: false,
            projectId: p.id,
          })
        ).map((c) => c.title)
      ).toEqual(["in"]);
      await store.setConversationArchived("alice", inP!.id, true);
      expect(
        (await store.listConversations("alice", { archived: true })).map(
          (c) => c.title
        )
      ).toEqual(["in"]);
      expect(
        await store.listConversations("alice", {
          archived: false,
          projectId: "not-a-uuid",
        })
      ).toEqual([]);
    });

    it("returns the latest messages oldest-first", async () => {
      const store = await make();
      const c = await store.createConversation("alice", {
        projectId: null,
        title: "",
        modelId: "m1",
      });
      for (const [i, role] of (
        ["user", "assistant", "user"] as const
      ).entries()) {
        await store.appendMessage("alice", c!.id, {
          role,
          content: `m${i}`,
          modelId: role === "assistant" ? "m1" : undefined,
        } as never);
      }
      expect(
        (await store.listMessages("alice", c!.id, 10))!.map((m) => m.content)
      ).toEqual(["m0", "m1", "m2"]);
      expect(
        (await store.listMessages("alice", c!.id, 2))!.map((m) => m.content)
      ).toEqual(["m1", "m2"]);
    });

    it("sets a title only when it is empty", async () => {
      const store = await make();
      const c = await store.createConversation("alice", {
        projectId: null,
        title: "",
        modelId: "m1",
      });
      await store.setTitleIfEmpty("alice", c!.id, "first");
      await store.setTitleIfEmpty("alice", c!.id, "second");
      await store.setTitleIfEmpty("bob", c!.id, "hijack");
      expect((await store.getConversation("alice", c!.id))?.title).toBe(
        "first"
      );
    });
  });
}
