import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AuthEnv } from "../auth/middleware.js";
import type { PolicyDecisionClient } from "../auth/policy.js";
import { costMicroUsd } from "../cost/estimate.js";
import { GateError, type CostGate, type GatedRequest } from "../cost/gate.js";
import type { AuditLog } from "../db/audit.js";
import type { ModelCatalog } from "../models/catalog.js";
import {
  ModelError,
  type ChatMessage,
  type StreamEvent,
} from "../models/types.js";
import type { ChatStore, StoredMessage } from "./types.js";

export const MAX_TEXT_CHARS = 8000;
/** Messages replayed to the model. Bounds the reserved (and actual) cost. */
export const HISTORY_LIMIT = 20;
const VIEW_LIMIT = 200;

export type ChatDeps = {
  store: ChatStore;
  catalog: ModelCatalog;
  gate: CostGate;
  policy: PolicyDecisionClient;
  audit: AuditLog;
  /** Upper bound per answer; the model's own limit still applies. */
  maxOutputTokens: number;
  now?: () => Date;
};

type Ctx = Context<AuthEnv>;

function json(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const notFound = () => json(404, { error: "not_found" });
const badRequest = (error = "bad_request") => json(400, { error });

/** Maps gate and model failures to a status that is safe to show. */
function errorResponse(error: unknown): Response {
  if (error instanceof GateError) {
    switch (error.code) {
      case "limit_exceeded":
        return json(
          429,
          { error: "limit_exceeded", reason: error.reason },
          error.reason === "rate" ? { "retry-after": "60" } : {}
        );
      case "request_too_large":
        return json(413, { error: "request_too_large" });
      case "kill_switch":
      case "store_unavailable":
        return json(503, { error: "unavailable" });
    }
  }
  if (error instanceof ModelError) {
    switch (error.code) {
      case "unknown_model":
      case "max_output_exceeded":
        return badRequest(error.code);
      case "price_unverified":
      case "price_expired":
        return json(503, { error: "model_unavailable" });
      default:
        return json(502, { error: "provider_error" });
    }
  }
  console.error("unexpected chat error", error);
  return json(500, { error: "internal_error" });
}

/** A code for the SSE `error` event (after the stream has started). */
function errorCode(error: unknown): string {
  if (error instanceof GateError || error instanceof ModelError) {
    return error.code;
  }
  return "internal_error";
}

async function readJson<T extends z.ZodType>(
  c: Ctx,
  schema: T
): Promise<z.infer<T> | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

const flag = (value: string | undefined) => value === "true";

/**
 * Providers require alternating roles starting with a user turn. A failed
 * answer leaves a user message without a reply, and the history window can cut
 * a pair, so normalize: merge neighbours of the same role, drop a leading
 * assistant turn.
 */
export function toChatMessages(
  history: readonly StoredMessage[],
  text: string
): ChatMessage[] {
  const turns: ChatMessage[] = [];
  for (const m of [...history, { role: "user" as const, content: text }]) {
    const last = turns.at(-1);
    if (last && last.role === m.role) {
      last.text = `${last.text}\n\n${m.content}`;
    } else {
      turns.push({ role: m.role, text: m.content });
    }
  }
  while (turns[0]?.role === "assistant") turns.shift();
  return turns;
}

function titleFrom(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 60);
}

export function chatRoutes(deps: ChatDeps) {
  const { store, catalog, gate, policy, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono<AuthEnv>();

  const record = (
    actorId: string,
    action: string,
    resource: string,
    detail: Record<string, unknown> = {}
  ) =>
    audit.record({ actorId, action, resource, detail }).catch((error) => {
      console.error("audit write failed", action, error);
    });

  /** The model must be callable now and allowed for this user. */
  async function checkModel(c: Ctx, modelId: string): Promise<Response | null> {
    try {
      catalog.resolve(modelId, now());
    } catch (error) {
      return errorResponse(error);
    }
    const decision = await policy.authorize(c.get("session"), {
      action: "ai:UseModel",
      resource: `ivrm:ai:model/${modelId}`,
    });
    if (decision.allowed) return null;
    return decision.reason === "decision_unavailable"
      ? json(503, { error: "unavailable" })
      : json(403, { error: "forbidden" });
  }

  app.get("/models", async (c) => {
    const session = c.get("session");
    const callable = catalog.listCallable(now());
    const allowed = await Promise.all(
      callable.map(async (m) => {
        const d = await policy.authorize(session, {
          action: "ai:UseModel",
          resource: `ivrm:ai:model/${m.id}`,
        });
        return d.allowed ? m : null;
      })
    );
    return c.json({
      models: allowed
        .filter((m) => m !== null)
        .map((m) => ({ id: m.id, label: m.label, supports: m.supports })),
    });
  });

  // ---- projects --------------------------------------------------------

  const projectBody = z.object({
    name: z.string().trim().min(1).max(200),
    instructions: z.string().max(MAX_TEXT_CHARS).default(""),
  });
  const projectPatch = z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      instructions: z.string().max(MAX_TEXT_CHARS).optional(),
    })
    .refine((v) => v.name !== undefined || v.instructions !== undefined);

  app.get("/projects", async (c) => {
    const owner = c.get("session").userId;
    const projects = await store.listProjects(owner, {
      archived: flag(c.req.query("archived")),
    });
    return c.json({ projects });
  });

  app.post("/projects", async (c) => {
    const body = await readJson(c, projectBody);
    if (!body) return badRequest();
    const owner = c.get("session").userId;
    const project = await store.createProject(owner, body);
    await record(owner, "project.create", `project/${project.id}`);
    return json(201, { project });
  });

  app.get("/projects/:id", async (c) => {
    const project = await store.getProject(
      c.get("session").userId,
      c.req.param("id")
    );
    return project ? c.json({ project }) : notFound();
  });

  app.patch("/projects/:id", async (c) => {
    const body = await readJson(c, projectPatch);
    if (!body) return badRequest();
    const owner = c.get("session").userId;
    const project = await store.updateProject(owner, c.req.param("id"), {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.instructions !== undefined
        ? { instructions: body.instructions }
        : {}),
    });
    if (!project) return notFound();
    await record(owner, "project.update", `project/${project.id}`);
    return c.json({ project });
  });

  for (const [path, archived] of [
    ["archive", true],
    ["unarchive", false],
  ] as const) {
    app.post(`/projects/:id/${path}`, async (c) => {
      const owner = c.get("session").userId;
      const project = await store.setProjectArchived(
        owner,
        c.req.param("id"),
        archived
      );
      if (!project) return notFound();
      await record(owner, `project.${path}`, `project/${project.id}`);
      return c.json({ project });
    });
  }

  // ---- conversations ---------------------------------------------------

  const conversationBody = z.object({
    modelId: z.string().min(1).max(100),
    projectId: z.string().min(1).max(100).nullable().default(null),
    title: z.string().trim().max(300).default(""),
  });

  app.get("/conversations", async (c) => {
    const owner = c.get("session").userId;
    const projectId = c.req.query("projectId");
    const conversations = await store.listConversations(owner, {
      archived: flag(c.req.query("archived")),
      ...(projectId !== undefined ? { projectId } : {}),
    });
    return c.json({ conversations });
  });

  app.post("/conversations", async (c) => {
    const body = await readJson(c, conversationBody);
    if (!body) return badRequest();
    const denied = await checkModel(c, body.modelId);
    if (denied) return denied;
    const owner = c.get("session").userId;
    const conversation = await store.createConversation(owner, body);
    if (!conversation) return notFound();
    await record(
      owner,
      "conversation.create",
      `conversation/${conversation.id}`,
      {
        model: body.modelId,
      }
    );
    return json(201, { conversation });
  });

  app.get("/conversations/:id", async (c) => {
    const owner = c.get("session").userId;
    const id = c.req.param("id");
    const conversation = await store.getConversation(owner, id);
    if (!conversation) return notFound();
    const messages = (await store.listMessages(owner, id, VIEW_LIMIT)) ?? [];
    return c.json({ conversation, messages });
  });

  for (const [path, archived] of [
    ["archive", true],
    ["unarchive", false],
  ] as const) {
    app.post(`/conversations/:id/${path}`, async (c) => {
      const owner = c.get("session").userId;
      const conversation = await store.setConversationArchived(
        owner,
        c.req.param("id"),
        archived
      );
      if (!conversation) return notFound();
      await record(
        owner,
        `conversation.${path}`,
        `conversation/${conversation.id}`
      );
      return c.json({ conversation });
    });
  }

  // ---- send a message (SSE) -------------------------------------------

  const messageBody = z.object({
    text: z.string().trim().min(1).max(MAX_TEXT_CHARS),
    modelId: z.string().min(1).max(100).optional(),
  });

  app.post("/conversations/:id/messages", async (c) => {
    const owner = c.get("session").userId;
    const id = c.req.param("id");
    const body = await readJson(c, messageBody);
    if (!body) return badRequest();

    const conversation = await store.getConversation(owner, id);
    if (!conversation) return notFound();

    const modelId = body.modelId ?? conversation.modelId;
    const denied = await checkModel(c, modelId);
    if (denied) return denied;
    const spec = catalog.resolve(modelId, now());

    const history = (await store.listMessages(owner, id, HISTORY_LIMIT)) ?? [];
    const project = conversation.projectId
      ? await store.getProject(owner, conversation.projectId)
      : null;

    const request: GatedRequest = {
      userId: owner,
      modelId,
      messages: toChatMessages(history, body.text),
      maxOutputTokens: Math.min(deps.maxOutputTokens, spec.maxOutputTokens),
      signal: c.req.raw.signal,
      ...(project?.instructions ? { system: project.instructions } : {}),
    };

    // Pull the first event before opening the stream, so a refusal from the
    // cost gate is a normal HTTP error and not an SSE event.
    const iterator = gate.stream(request)[Symbol.asyncIterator]();
    let first: IteratorResult<StreamEvent, void>;
    try {
      first = await iterator.next();
    } catch (error) {
      return errorResponse(error);
    }
    if (first.done) {
      return json(502, { error: "provider_error" });
    }

    try {
      await store.appendMessage(owner, id, {
        role: "user",
        content: body.text,
      });
    } catch (error) {
      await iterator.return?.(undefined).catch(() => undefined);
      return errorResponse(error);
    }

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        void iterator.return?.(undefined).catch(() => undefined);
      });
      let answer = "";
      try {
        let step: IteratorResult<StreamEvent, void> = first;
        while (!step.done) {
          const event = step.value;
          if (event.type === "text") {
            answer += event.text;
            await stream.writeSSE({
              event: "delta",
              data: JSON.stringify({ text: event.text }),
            });
          } else {
            const cost = costMicroUsd(spec.pricing, event.usage);
            const saved = await store.appendMessage(owner, id, {
              role: "assistant",
              content: answer,
              modelId,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              costMicroUsd: cost,
            });
            await store.setTitleIfEmpty(owner, id, titleFrom(body.text));
            await record(owner, "chat.message", `conversation/${id}`, {
              model: modelId,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              costMicroUsd: cost,
            });
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({
                messageId: saved?.id ?? null,
                usage: event.usage,
                costMicroUsd: cost,
                stopReason: event.stopReason,
              }),
            });
          }
          step = await iterator.next();
        }
      } catch (error) {
        // No assistant message is saved; the gate keeps the full reservation.
        await stream
          .writeSSE({
            event: "error",
            data: JSON.stringify({ code: errorCode(error) }),
          })
          .catch(() => undefined);
        await iterator.return?.(undefined).catch(() => undefined);
      }
    });
  });

  return app;
}
