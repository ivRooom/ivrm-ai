import { describe, expect, it } from "vitest";
import { matchingTitle, serializeConversation } from "./conversation-tools.js";

const conversation = {
  id: "one",
  title: "設計 <script>",
  projectId: null,
  modelId: "m1",
  archived: false,
  updatedAt: "2026-11-11",
};
const messages = [
  {
    id: "m",
    role: "assistant" as const,
    content: "```ts\nconst x = '<script>';\n```\n日本語",
    modelId: "m1",
  },
];
describe("conversation tools", () => {
  it("preserves original content and labels the limited export scope", () => {
    const json = JSON.parse(
      serializeConversation(conversation, messages, "json")
    );
    expect(json.messages).toEqual(messages);
    expect(json.scope).toBe("loaded-messages");
    const md = serializeConversation(conversation, messages, "md");
    expect(md).toContain(messages[0]!.content);
    expect(md).toContain("最大200");
  });
  it("normalizes width and case without treating input as a regular expression", () => {
    expect(matchingTitle("ＡＩ Project", " ai ")).toBe(true);
    expect(matchingTitle("設計 [案]", "[案]")).toBe(true);
    expect(matchingTitle("設計", "別")).toBe(false);
  });
});
