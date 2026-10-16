import { describe, expect, it } from "vitest";
import type { ChatStore } from "./types.js";

const MISSING = "00000000-0000-4000-8000-000000000000";

/** Behaviour every ChatStore must share (in-memory and Postgres). */
export function chatStoreContract(
  name: string,
  make: () => Promise<ChatStore>
) {
  describe(`ChatStore contract: ${name}`, () => {
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
