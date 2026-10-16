import { randomUUID } from "node:crypto";
import type {
  ChatStore,
  Conversation,
  NewMessage,
  Project,
  StoredMessage,
} from "./types.js";

type ProjectRow = Project & { ownerId: string };
type ConversationRow = Conversation & { ownerId: string };
type MessageRow = StoredMessage & { conversationId: string };

/** In-memory ChatStore for tests and local development. */
export class InMemoryChatStore implements ChatStore {
  private readonly projects = new Map<string, ProjectRow>();
  private readonly conversations = new Map<string, ConversationRow>();
  private readonly messages: MessageRow[] = [];
  private tick = 0;

  private stamp(): string {
    // Strictly increasing, so ordering by updatedAt is deterministic in tests.
    return new Date(Date.UTC(2026, 0, 1) + this.tick++ * 1000).toISOString();
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

  async setTitleIfEmpty(
    ownerId: string,
    id: string,
    title: string
  ): Promise<void> {
    const row = this.conversations.get(id);
    if (row && row.ownerId === ownerId && row.title === "") row.title = title;
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
      .map(({ conversationId: _ignored, ...message }) => message);
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
      role: message.role,
      content: message.content,
      modelId: message.modelId ?? null,
      createdAt: this.stamp(),
    };
    this.messages.push(row);
    conversation.updatedAt = this.stamp();
    const { conversationId: _ignored, ...stored } = row;
    return stored;
  }
}

function strip<T extends { ownerId: string }>(row: T): Omit<T, "ownerId"> {
  const { ownerId: _ignored, ...rest } = row;
  return rest;
}
