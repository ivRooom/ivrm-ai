// Client for this site's own API (/api). The page never talks to api.ivrm.jp
// with credentials: ivrm-ai checks the session server to server.

export type Model = { id: string; label: string };
export type Project = {
  id: string;
  name: string;
  instructions: string;
  archived: boolean;
};
export type Conversation = {
  id: string;
  projectId: string | null;
  title: string;
  modelId: string;
  archived: boolean;
  updatedAt: string;
};
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelId: string | null;
};
export type Me = { id: string; username: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason?: string,
    readonly retryAfterSeconds?: number
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    reason?: unknown;
  } | null;
  const retry = Number(response.headers.get("retry-after"));
  return new ApiError(
    response.status,
    typeof body?.error === "string" ? body.error : "error",
    typeof body?.reason === "string" ? body.reason : undefined,
    Number.isFinite(retry) && retry > 0 ? retry : undefined
  );
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

export const api = {
  me: () => call<{ user: Me }>("GET", "/me").then((r) => r.user),
  models: () =>
    call<{ models: Model[] }>("GET", "/models").then((r) => r.models),
  projects: (archived: boolean) =>
    call<{ projects: Project[] }>("GET", `/projects?archived=${archived}`).then(
      (r) => r.projects
    ),
  createProject: (input: { name: string; instructions: string }) =>
    call<{ project: Project }>("POST", "/projects", input).then(
      (r) => r.project
    ),
  updateProject: (id: string, input: { name: string; instructions: string }) =>
    call<{ project: Project }>(
      "PATCH",
      `/projects/${encodeURIComponent(id)}`,
      input
    ).then((r) => r.project),
  setProjectArchived: (id: string, archived: boolean) =>
    call<{ project: Project }>(
      "POST",
      `/projects/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`
    ).then((r) => r.project),
  conversations: (archived: boolean, projectId?: string) => {
    const q = new URLSearchParams({ archived: String(archived) });
    if (projectId) q.set("projectId", projectId);
    return call<{ conversations: Conversation[] }>(
      "GET",
      `/conversations?${q}`
    ).then((r) => r.conversations);
  },
  createConversation: (input: { modelId: string; projectId: string | null }) =>
    call<{ conversation: Conversation }>("POST", "/conversations", input).then(
      (r) => r.conversation
    ),
  conversation: (id: string) =>
    call<{ conversation: Conversation; messages: Message[] }>(
      "GET",
      `/conversations/${encodeURIComponent(id)}`
    ),
  setConversationArchived: (id: string, archived: boolean) =>
    call<{ conversation: Conversation }>(
      "POST",
      `/conversations/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`
    ).then((r) => r.conversation),
};

export type SseEvent = { event: string; data: string };

/** Splits a text/event-stream body into events. Comments and ids are ignored. */
export async function* readSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:"))
            data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length > 0) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type SendEvent =
  | { type: "delta"; text: string }
  | { type: "done"; costMicroUsd: number }
  | { type: "error"; code: string };

/** Sends a message and yields the streamed answer. HTTP refusals throw ApiError. */
export async function* sendMessage(
  conversationId: string,
  input: { text: string; modelId: string },
  signal: AbortSignal
): AsyncGenerator<SendEvent> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(input),
      signal,
    }
  );
  if (!response.ok || !response.body) throw await toApiError(response);
  for await (const { event, data } of readSse(response.body)) {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (event === "delta" && typeof parsed["text"] === "string") {
      yield { type: "delta", text: parsed["text"] };
    } else if (event === "done") {
      yield {
        type: "done",
        costMicroUsd: Number(parsed["costMicroUsd"] ?? 0),
      };
    } else if (event === "error") {
      yield { type: "error", code: String(parsed["code"] ?? "error") };
    }
  }
}

/** A message for the person, in Japanese. Never includes server details. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "通信に失敗しました。接続を確認して、もう一度お試しください。";
  }
  switch (error.status) {
    case 401:
      return "ログインが必要です。";
    case 403:
      return "この操作は許可されていません。";
    case 404:
      return "見つかりませんでした。";
    case 413:
      return "メッセージが長すぎるか、1 回の上限額を超えます。短くしてください。";
    case 429: {
      const wait = error.retryAfterSeconds
        ? `${error.retryAfterSeconds} 秒ほど待ってから、もう一度お試しください。`
        : "";
      switch (error.reason) {
        case "user_daily":
          return "今日の利用上限に達しました。明日(日本時間 0 時以降)にお試しください。";
        case "global_monthly":
          return "今月の全体の利用上限に達しました。運営にお問い合わせください。";
        case "concurrency":
          return "同時に送れる数を超えています。前の回答が終わってから送ってください。";
        default:
          return `送信が多すぎます。${wait}`;
      }
    }
    case 503:
      return error.code === "model_unavailable"
        ? "このモデルは今使えません。別のモデルを選んでください。"
        : "AI は一時的に停止しています。しばらくしてからお試しください。";
    case 400:
      return "入力を確認してください。";
    default:
      return "エラーが発生しました。しばらくしてからお試しください。";
  }
}

/** Shown when the stream itself ends with an error event. */
export function describeStreamError(code: string): string {
  return code === "kill_switch" || code === "store_unavailable"
    ? "AI は一時的に停止しています。回答は保存されていません。"
    : "回答の途中でエラーになりました。回答は保存されていません。";
}
