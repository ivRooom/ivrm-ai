export type Project = {
  id: string;
  name: string;
  instructions: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Conversation = {
  id: string;
  projectId: string | null;
  title: string;
  modelId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelId: string | null;
  createdAt: string;
};

export type ContextUsage = {
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  measuredAt: string;
};

export type NewMessage = {
  role: "user" | "assistant";
  content: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicroUsd?: number;
};

export const MAX_FORK_MESSAGES = 200;
export const MAX_FORK_BYTES = 512 * 1024;
export type ForkResult =
  | { conversation: Conversation; draft: string }
  | {
      error: "conversation_archived" | "project_archived" | "history_too_large";
    }
  | null;

/**
 * Persistence for chat. Every method takes the owner and only ever touches that
 * owner's rows: an id that belongs to someone else behaves as if it did not
 * exist (null / empty), so callers cannot leak or modify other users' data.
 */
export interface ChatStore {
  /** Usage contains no prompt/answer text and is scoped to the conversation owner. */
  getUsageBuckets(ownerId: string): Promise<import("./usage.js").UsageBucket[]>;
  createProject(
    ownerId: string,
    input: { name: string; instructions: string }
  ): Promise<Project>;
  getProject(ownerId: string, id: string): Promise<Project | null>;
  listProjects(
    ownerId: string,
    options: { archived: boolean }
  ): Promise<Project[]>;
  updateProject(
    ownerId: string,
    id: string,
    patch: { name?: string; instructions?: string }
  ): Promise<Project | null>;
  setProjectArchived(
    ownerId: string,
    id: string,
    archived: boolean
  ): Promise<Project | null>;

  /** Null when `projectId` is given but is not the owner's project. */
  createConversation(
    ownerId: string,
    input: { projectId: string | null; title: string; modelId: string }
  ): Promise<Conversation | null>;
  getConversation(ownerId: string, id: string): Promise<Conversation | null>;
  listConversations(
    ownerId: string,
    options: { archived: boolean; projectId?: string }
  ): Promise<Conversation[]>;
  setConversationArchived(
    ownerId: string,
    id: string,
    archived: boolean
  ): Promise<Conversation | null>;
  renameConversation(
    ownerId: string,
    id: string,
    title: string
  ): Promise<Conversation | null>;
  setTitleIfEmpty(ownerId: string, id: string, title: string): Promise<void>;

  /** Atomically copies the complete prefix BEFORE an owned user message. Never invokes AI. */
  forkConversation(
    ownerId: string,
    sourceId: string,
    messageId: string,
    modelId: string
  ): Promise<ForkResult>;

  /** The latest `limit` messages, oldest first. Null if not the owner's. */
  latestContextUsage(
    ownerId: string,
    conversationId: string
  ): Promise<ContextUsage | null>;
  listMessages(
    ownerId: string,
    conversationId: string,
    limit: number
  ): Promise<StoredMessage[] | null>;
  appendMessage(
    ownerId: string,
    conversationId: string,
    message: NewMessage
  ): Promise<StoredMessage | null>;
}
