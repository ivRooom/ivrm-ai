import { MAX_FORK_MESSAGES, MAX_FORK_BYTES, type ForkResult } from "./types.js";
import type { UsageBucket } from "./usage.js";
import type { Pool } from "pg";
import type {
  ChatStore,
  ContextUsage,
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

  async getUsageBuckets(ownerId: string): Promise<UsageBucket[]> {
    const { rows } = await this.pool.query(
      `SELECT (m.created_at AT TIME ZONE 'Asia/Tokyo')::date::text AS date,
      COALESCE(m.model_id, 'unknown') AS model_id, count(*) AS answers,
      sum(m.input_tokens::bigint + m.output_tokens::bigint) AS tokens,
      max(m.input_tokens::bigint + m.output_tokens::bigint) AS max_tokens,
      sum(m.input_tokens::bigint) AS input_tokens, sum(m.output_tokens::bigint) AS output_tokens,
      sum(m.cost_micro_usd) AS cost_micro_usd
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.owner_id = $1 AND m.role = 'assistant' AND m.input_tokens IS NOT NULL
        AND m.output_tokens IS NOT NULL AND m.cost_micro_usd IS NOT NULL
      GROUP BY 1, 2 ORDER BY 1, 2`,
      [ownerId]
    );
    return rows.map((r) => ({
      date: String(r.date),
      modelId: String(r.model_id),
      answers: Number(r.answers),
      tokens: Number(r.tokens),
      maxTokens: Number(r.max_tokens),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      costMicroUsd: Number(r.cost_micro_usd),
    }));
  }

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

  async renameConversation(
    ownerId: string,
    id: string,
    title: string
  ): Promise<Conversation | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query(
      `UPDATE conversations SET title = $3, updated_at = now()
       WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [id, ownerId, title]
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

  async forkConversation(
    ownerId: string,
    sourceId: string,
    messageId: string,
    modelId: string
  ): Promise<ForkResult> {
    if (!isUuid(sourceId) || !isUuid(messageId)) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const sourceRows = await client.query(
        "SELECT * FROM conversations WHERE id = $1 AND owner_id = $2 FOR SHARE",
        [sourceId, ownerId]
      );
      const source = sourceRows.rows[0];
      if (!source) {
        await client.query("ROLLBACK");
        return null;
      }
      const targetRows = await client.query(
        "SELECT seq, content FROM messages WHERE id = $1 AND conversation_id = $2 AND role = 'user'",
        [messageId, sourceId]
      );
      const target = targetRows.rows[0];
      if (!target) {
        await client.query("ROLLBACK");
        return null;
      }
      if (source.archived_at !== null) {
        await client.query("ROLLBACK");
        return { error: "conversation_archived" };
      }
      if (source.project_id) {
        const projectRows = await client.query(
          "SELECT archived_at FROM projects WHERE id = $1 AND owner_id = $2 FOR SHARE",
          [source.project_id, ownerId]
        );
        if (!projectRows.rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
        if (projectRows.rows[0].archived_at !== null) {
          await client.query("ROLLBACK");
          return { error: "project_archived" };
        }
      }
      const sizeRows = await client.query(
        "SELECT count(*) AS count, COALESCE(sum(octet_length(content)), 0) AS bytes FROM messages WHERE conversation_id = $1 AND seq < $2",
        [sourceId, target.seq]
      );
      if (
        Number(sizeRows.rows[0].count) > MAX_FORK_MESSAGES ||
        Number(sizeRows.rows[0].bytes) > MAX_FORK_BYTES
      ) {
        await client.query("ROLLBACK");
        return { error: "history_too_large" };
      }
      const title = source.title
        ? Array.from(String(source.title)).slice(0, 290).join("") + " / 分岐"
        : "分岐した会話";
      const created = await client.query(
        "INSERT INTO conversations (owner_id, project_id, title, model_id) VALUES ($1, $2, $3, $4) RETURNING *",
        [ownerId, source.project_id, title, modelId]
      );
      const conversation = toConversation(created.rows[0]);
      await client.query(
        `INSERT INTO messages (conversation_id, role, content, model_id)
        SELECT $1, role, content, model_id FROM messages WHERE conversation_id = $2 AND seq < $3 ORDER BY seq`,
        [conversation.id, sourceId, target.seq]
      );
      await client.query("COMMIT");
      return { conversation, draft: String(target.content) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async latestContextUsage(
    ownerId: string,
    conversationId: string
  ): Promise<ContextUsage | null> {
    if (!isUuid(conversationId)) return null;
    const { rows } = await this.pool.query(
      `SELECT m.model_id, m.input_tokens, m.output_tokens, m.created_at
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.owner_id = $1 AND m.conversation_id = $2 AND m.role = 'assistant'
         AND m.input_tokens IS NOT NULL AND m.output_tokens IS NOT NULL
       ORDER BY m.seq DESC LIMIT 1`,
      [ownerId, conversationId]
    );
    const row = rows[0];
    return row
      ? {
          modelId: row.model_id,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          measuredAt: iso(row.created_at),
        }
      : null;
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
