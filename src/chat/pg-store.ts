import type { Pool } from "pg";
import type {
  ChatStore,
  Conversation,
  NewMessage,
  Project,
  StoredMessage,
} from "./types.js";

type Row = Record<string, unknown>;

const iso = (value: unknown) => (value as Date).toISOString();

const toProject = (r: Row): Project => ({
  id: r["id"] as string,
  name: r["name"] as string,
  instructions: r["instructions"] as string,
  archived: r["archived_at"] !== null,
  createdAt: iso(r["created_at"]),
  updatedAt: iso(r["updated_at"]),
});

const toConversation = (r: Row): Conversation => ({
  id: r["id"] as string,
  projectId: (r["project_id"] as string | null) ?? null,
  title: r["title"] as string,
  modelId: r["model_id"] as string,
  archived: r["archived_at"] !== null,
  createdAt: iso(r["created_at"]),
  updatedAt: iso(r["updated_at"]),
});

const toMessage = (r: Row): StoredMessage => ({
  id: r["id"] as string,
  role: r["role"] as "user" | "assistant",
  content: r["content"] as string,
  modelId: (r["model_id"] as string | null) ?? null,
  createdAt: iso(r["created_at"]),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id can never match a row; avoid a Postgres cast error. */
export const isUuid = (value: string) => UUID.test(value);

export class PostgresChatStore implements ChatStore {
  constructor(private readonly pool: Pool) {}

  async createProject(
    ownerId: string,
    input: { name: string; instructions: string }
  ): Promise<Project> {
    const { rows } = await this.pool.query(
      `INSERT INTO projects (owner_id, name, instructions)
       VALUES ($1, $2, $3) RETURNING *`,
      [ownerId, input.name, input.instructions]
    );
    return toProject(rows[0]);
  }

  async getProject(ownerId: string, id: string): Promise<Project | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query(
      "SELECT * FROM projects WHERE id = $1 AND owner_id = $2",
      [id, ownerId]
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async listProjects(
    ownerId: string,
    options: { archived: boolean }
  ): Promise<Project[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM projects
        WHERE owner_id = $1 AND (archived_at IS NOT NULL) = $2
        ORDER BY updated_at DESC, id`,
      [ownerId, options.archived]
    );
    return rows.map(toProject);
  }

  async updateProject(
    ownerId: string,
    id: string,
    patch: { name?: string; instructions?: string }
  ): Promise<Project | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query(
      `UPDATE projects
          SET name = COALESCE($3, name),
              instructions = COALESCE($4, instructions),
              updated_at = now()
        WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [id, ownerId, patch.name ?? null, patch.instructions ?? null]
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async setProjectArchived(
    ownerId: string,
    id: string,
    archived: boolean
  ): Promise<Project | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query(
      `UPDATE projects
          SET archived_at = CASE WHEN $3 THEN COALESCE(archived_at, now())
                                 ELSE NULL END,
              updated_at = now()
        WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [id, ownerId, archived]
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async createConversation(
    ownerId: string,
    input: { projectId: string | null; title: string; modelId: string }
  ): Promise<Conversation | null> {
    if (input.projectId !== null) {
      if (!(await this.getProject(ownerId, input.projectId))) return null;
    }
    const { rows } = await this.pool.query(
      `INSERT INTO conversations (owner_id, project_id, title, model_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [ownerId, input.projectId, input.title, input.modelId]
    );
    return toConversation(rows[0]);
  }

  async getConversation(
    ownerId: string,
    id: string
  ): Promise<Conversation | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query(
      "SELECT * FROM conversations WHERE id = $1 AND owner_id = $2",
      [id, ownerId]
    );
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async listConversations(
    ownerId: string,
    options: { archived: boolean; projectId?: string }
  ): Promise<Conversation[]> {
    if (options.projectId !== undefined && !isUuid(options.projectId)) {
      return [];
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM conversations
        WHERE owner_id = $1 AND (archived_at IS NOT NULL) = $2
          AND ($3::uuid IS NULL OR project_id = $3::uuid)
        ORDER BY updated_at DESC, id`,
      [ownerId, options.archived, options.projectId ?? null]
    );
    return rows.map(toConversation);
  }

  async setConversationArchived(
    ownerId: string,
    id: string,
    archived: boolean
  ): Promise<Conversation | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query(
      `UPDATE conversations
          SET archived_at = CASE WHEN $3 THEN COALESCE(archived_at, now())
                                 ELSE NULL END,
              updated_at = now()
        WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [id, ownerId, archived]
    );
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async setTitleIfEmpty(
    ownerId: string,
    id: string,
    title: string
  ): Promise<void> {
    if (!isUuid(id)) return;
    await this.pool.query(
      `UPDATE conversations SET title = $3
        WHERE id = $1 AND owner_id = $2 AND title = ''`,
      [id, ownerId, title]
    );
  }

  async listMessages(
    ownerId: string,
    conversationId: string,
    limit: number
  ): Promise<StoredMessage[] | null> {
    if (!(await this.getConversation(ownerId, conversationId))) return null;
    const { rows } = await this.pool.query(
      `SELECT * FROM (
         SELECT * FROM messages WHERE conversation_id = $1
          ORDER BY seq DESC LIMIT $2
       ) latest ORDER BY seq ASC`,
      [conversationId, limit]
    );
    return rows.map(toMessage);
  }

  async appendMessage(
    ownerId: string,
    conversationId: string,
    message: NewMessage
  ): Promise<StoredMessage | null> {
    if (!(await this.getConversation(ownerId, conversationId))) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO messages
           (conversation_id, role, content, model_id,
            input_tokens, output_tokens, cost_micro_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          conversationId,
          message.role,
          message.content,
          message.modelId ?? null,
          message.inputTokens ?? null,
          message.outputTokens ?? null,
          message.costMicroUsd ?? null,
        ]
      );
      await client.query(
        "UPDATE conversations SET updated_at = now() WHERE id = $1",
        [conversationId]
      );
      await client.query("COMMIT");
      return toMessage(rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
