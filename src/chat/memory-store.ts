import { dayKey } from "../cost/store.js";
import type { UsageBucket } from "./usage.js";
import { randomUUID } from "node:crypto";
import { MAX_FORK_MESSAGES, MAX_FORK_BYTES, type ForkResult } from "./types.js";
import type {
  ChatStore,
  Conversation,
  NewMessage,
  Project,
  StoredMessage,
} from "./types.js";

type ProjectRow = Project & { ownerId: string };
type ConversationRow = Conversation & { ownerId: string };
type MessageRow = StoredMessage & {
  conversationId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
};

/** In-memory ChatStore for tests and local development. */
export class InMemoryChatStore implements ChatStore {
  private readonly projects = new Map<string, ProjectRow>();
  private readonly conversations = new Map<string, ConversationRow>();
  private readonly messages: MessageRow[] = [];
  private tick = 0;

  constructor(private readonly epoch = () => Date.UTC(2026, 0, 1)) {}

  private stamp(): string {
    // Strictly increasing, so ordering by updatedAt is deterministic in tests.
    return new Date(this.epoch() + this.tick++ * 1000).toISOString();
  }

  async getUsageBuckets(ownerId: string): Promise<UsageBucket[]> {
    const buckets = new Map<string, UsageBucket>();
    for (const m of this.messages) {
      if (
        this.conversations.get(m.conversationId)?.ownerId !== ownerId ||
        m.role !== "assistant" ||
        m.inputTokens === null ||
        m.outputTokens === null ||
        m.costMicroUsd === null
      )
        continue;
      const date = dayKey(new Date(m.createdAt));
      const modelId = m.modelId ?? "unknown";
      const key = date + ":" + modelId;
      const row = buckets.get(key) ?? {
        date,
        modelId,
        answers: 0,
        tokens: 0,
        maxTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      const tokens = m.inputTokens + m.outputTokens;
      row.answers++;
      row.tokens += tokens;
      row.maxTokens = Math.max(row.maxTokens, tokens);
      row.inputTokens += m.inputTokens;
      row.outputTokens += m.outputTokens;
      buckets.set(key, row);
    }
    return [...buckets.values()].sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.modelId.localeCompare(b.modelId)
    );
  }

  async createProject(
    ownerId: string,
    input: { name: string; instructions: string }
  ): Promise<Project> {
    const at = this.stamp();
    const row: ProjectRow = {
      id: randomUUID(),
      ownerId,
      name: input.name,
      instructions: input.instructions,
      archived: false,
      createdAt: at,
      updatedAt: at,
    };
    this.projects.set(row.id, row);
    return strip(row);
  }

  async getProject(ownerId: string, id: string): Promise<Project | null> {
    const row = this.projects.get(id);
    return row && row.ownerId === ownerId ? strip(row) : null;
  }

  async listProjects(
    ownerId: string,
    options: { archived: boolean }
  ): Promise<Project[]> {
    return [...this.projects.values()]
      .filter((p) => p.ownerId === ownerId && p.archived === options.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(strip);
  }

  async updateProject(
    ownerId: string,
    id: string,
    patch: { name?: string; instructions?: string }
  ): Promise<Project | null> {
    const row = this.projects.get(id);
    if (!row || row.ownerId !== ownerId) return null;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.instructions !== undefined) row.instructions = patch.instructions;
    row.updatedAt = this.stamp();
    return strip(row);
  }

  async setProjectArchived(
    ownerId: string,
    id: string,
    archived: boolean
  ): Promise<Project | null> {
    const row = this.projects.get(id);
    if (!row || row.ownerId !== ownerId) return null;
    row.archived = archived;
    row.updatedAt = this.stamp();
    return strip(row);
  }

  async createConversation(
    ownerId: string,
    input: { projectId: string | null; title: string; modelId: string }
  ): Promise<Conversation | null> {
    if (input.projectId !== null) {
      if (!(await this.getProject(ownerId, input.projectId))) return null;
    }
    const at = this.stamp();
    const row: ConversationRow = {
      id: randomUUID(),
      ownerId,
      projectId: input.projectId,
      title: input.title,
      modelId: input.modelId,
      archived: false,
      createdAt: at,
      updatedAt: at,
    };
    this.conversations.set(row.id, row);
    return strip(row);
  }

  async getConversation(
    ownerId: string,
    id: string
  ): Promise<Conversation | null> {
    const row = this.conversations.get(id);
    return row && row.ownerId === ownerId ? strip(row) : null;
  }

  async listConversations(
    ownerId: string,
    options: { archived: boolean; projectId?: string }
  ): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .filter(
        (c) =>
          c.ownerId === ownerId &&
          c.archived === options.archived &&
          (options.projectId === undefined || c.projectId === options.projectId)
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(strip);
  }

  async setConversationArchived(
    ownerId: string,
    id: string,
    archived: boolean
  ): Promise<Conversation | null> {
    const row = this.conversations.get(id);
    if (!row || row.ownerId !== ownerId) return null;
    row.archived = archived;
    row.updatedAt = this.stamp();
    return strip(row);
  }

  async renameConversation(
    ownerId: string,
    id: string,
    title: string
  ): Promise<Conversation | null> {
    const row = this.conversations.get(id);
    if (!row || row.ownerId !== ownerId) return null;
    row.title = title;
    row.updatedAt = this.stamp();
    return strip(row);
  }

  async setTitleIfEmpty(
    ownerId: string,
    id: string,
    title: string
  ): Promise<void> {
    const row = this.conversations.get(id);
    if (row && row.ownerId === ownerId && row.title === "") row.title = title;
  }

  async forkConversation(
    ownerId: string,
    sourceId: string,
    messageId: string,
    modelId: string
  ): Promise<ForkResult> {
    const source = this.conversations.get(sourceId);
    if (!source || source.ownerId !== ownerId) return null;
    const history = this.messages.filter((m) => m.conversationId === sourceId);
    const index = history.findIndex(
      (m) => m.id === messageId && m.role === "user"
    );
    if (index < 0) return null;
    if (source.archived) return { error: "conversation_archived" };
    if (source.projectId) {
      const project = this.projects.get(source.projectId);
      if (!project || project.ownerId !== ownerId) return null;
      if (project.archived) return { error: "project_archived" };
    }
    const prefix = history.slice(0, index);
    if (
      prefix.length > MAX_FORK_MESSAGES ||
      prefix.reduce((n, m) => n + Buffer.byteLength(m.content, "utf8"), 0) >
        MAX_FORK_BYTES
    )
      return { error: "history_too_large" };
    const at = this.stamp();
    const conversation: ConversationRow = {
      ...source,
      id: randomUUID(),
      modelId,
      title: source.title
        ? Array.from(source.title).slice(0, 290).join("") + " / 分岐"
        : "分岐した会話",
      archived: false,
      createdAt: at,
      updatedAt: at,
    };
    const copies = prefix.map((m) => ({
      ...m,
      inputTokens: null,
      outputTokens: null,
      costMicroUsd: null,
      id: randomUUID(),
      conversationId: conversation.id,
      createdAt: at,
    }));
    // All validation/allocation precedes mutation; no awaited work in the commit section.
    this.conversations.set(conversation.id, conversation);
    this.messages.push(...copies);
    return {
      conversation: strip(conversation),
      draft: history[index]!.content,
    };
  }

  async listMessages(
    ownerId: string,
    conversationId: string,
    limit: number
  ): Promise<StoredMessage[] | null> {
    if (!(await this.getConversation(ownerId, conversationId))) return null;
    return this.messages
      .filter((m) => m.conversationId === conversationId)
      .slice(-limit)
      .map(
        ({
          conversationId: _ignored,
          inputTokens: _input,
          outputTokens: _output,
          costMicroUsd: _cost,
          ...message
        }) => message
      );
  }

  async appendMessage(
    ownerId: string,
    conversationId: string,
    message: NewMessage
  ): Promise<StoredMessage | null> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.ownerId !== ownerId) return null;
    const row: MessageRow = {
      id: randomUUID(),
      conversationId,
      inputTokens: message.inputTokens ?? null,
      outputTokens: message.outputTokens ?? null,
      costMicroUsd: message.costMicroUsd ?? null,
      role: message.role,
      content: message.content,
      modelId: message.modelId ?? null,
      createdAt: this.stamp(),
    };
    this.messages.push(row);
    conversation.updatedAt = this.stamp();
    const {
      conversationId: _ignored,
      inputTokens: _input,
      outputTokens: _output,
      costMicroUsd: _cost,
      ...stored
    } = row;
    return stored;
  }
}

function strip<T extends { ownerId: string }>(row: T): Omit<T, "ownerId"> {
  const { ownerId: _ignored, ...rest } = row;
  return rest;
}
