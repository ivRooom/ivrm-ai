import type { Conversation, Message } from "./api.js";

/** Export exactly the loaded view; the API currently limits it to 200 messages. */
export function serializeConversation(
  conversation: Conversation,
  messages: Message[],
  format: "md" | "json"
): string {
  if (format === "json")
    return JSON.stringify(
      { version: 1, scope: "loaded-messages", conversation, messages },
      null,
      2
    );
  return `# ${conversation.title || "無題の会話"}\n\n> 読み込み済みの直近最大200メッセージ\n\n${messages.map((m) => `## ${m.role === "user" ? "あなた" : "AI"}\n\n${m.content}`).join("\n\n---\n\n")}\n`;
}

export function matchingTitle(title: string, query: string): boolean {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .includes(query.trim().normalize("NFKC").toLocaleLowerCase("ja"));
}
