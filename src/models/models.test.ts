import { describe, expect, it, vi } from "vitest";
import { BedrockChatModel, type ConverseClient } from "./bedrock.js";
import { ModelCatalog } from "./catalog.js";
import { createDefaultCatalog } from "./default-catalog.js";
import {
  ModelError,
  type GenerateRequest,
  type ModelSpec,
  type StreamEvent,
} from "./types.js";

const priced: ModelSpec = {
  id: "m1",
  label: "M1",
  bedrockModelId: "vendor.m1",
  region: "ap-northeast-1",
  maxOutputTokens: 1000,
  supports: { tools: false, reasoning: false, vision: false },
  pricing: {
    inputPerMTok: 1,
    outputPerMTok: 2,
    checkedAt: "2026-10-01",
    validUntil: "2026-12-31",
  },
};
const unpriced: ModelSpec = { ...priced, id: "m2", pricing: null };
const now = new Date("2026-10-16T00:00:00Z");

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ModelError ? error.code : "other";
  }
  return undefined;
}

describe("ModelCatalog", () => {
  const catalog = new ModelCatalog([priced, unpriced]);

  it("resolves a priced model", () => {
    expect(catalog.resolve("m1", now).id).toBe("m1");
  });

  it("rejects an unknown id", () => {
    expect(codeOf(() => catalog.resolve("nope", now))).toBe("unknown_model");
  });

  it("rejects a model whose price is not verified", () => {
    expect(codeOf(() => catalog.resolve("m2", now))).toBe("price_unverified");
  });

  it("fails closed after the price expires", () => {
    const later = new Date("2027-01-01T00:00:00Z");
    expect(codeOf(() => catalog.resolve("m1", later))).toBe("price_expired");
    expect(catalog.listCallable(later)).toEqual([]);
  });

  it("allows the last valid day", () => {
    const last = new Date("2026-12-31T23:59:59Z");
    expect(catalog.resolve("m1", last).id).toBe("m1");
  });

  it("rejects duplicate ids", () => {
    expect(() => new ModelCatalog([priced, priced])).toThrow();
  });

  it("lists only callable models", () => {
    expect(catalog.listCallable(now).map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("default catalog", () => {
  it("offers only the models with a verified price and access", () => {
    const catalog = createDefaultCatalog();
    expect(catalog.list().map((m) => m.id)).toEqual([
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "gpt-oss-120b",
      "deepseek-v3-2",
    ]);
    expect(
      catalog
        .listCallable(now)
        .map((m) => [m.id, m.pricing.inputPerMTok, m.pricing.outputPerMTok])
    ).toEqual([
      ["gpt-oss-120b", 0.18, 0.73],
      ["deepseek-v3-2", 0.74, 2.22],
    ]);
  });

  it("refuses the Claude models until access is granted", () => {
    const catalog = createDefaultCatalog();
    for (const id of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
      expect(codeOf(() => catalog.resolve(id, now))).toBe("price_unverified");
    }
  });

  it("invokes Claude through inference profiles, not the plain model id", () => {
    const ids = Object.fromEntries(
      createDefaultCatalog()
        .list()
        .map((m) => [m.id, m.bedrockModelId])
    );
    expect(ids["claude-sonnet-5-5"]).toBe("global.anthropic.claude-sonnet-5-5");
    expect(ids["claude-haiku-5-5"]).toBe("jp.anthropic.claude-haiku-5-5");
  });

  it("stops offering a model once its verified price is stale", () => {
    const catalog = createDefaultCatalog();
    expect(catalog.listCallable(new Date("2026-11-19T23:59:59Z"))).toHaveLength(
      2
    );
    expect(catalog.listCallable(new Date("2026-11-20T00:00:00Z"))).toEqual([]);
    expect(
      codeOf(() =>
        catalog.resolve("gpt-oss-120b", new Date("2026-11-20T00:00:00Z"))
      )
    ).toBe("price_expired");
  });
});

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: priced,
    messages: [{ role: "user", text: "hi" }],
    maxOutputTokens: 100,
    ...overrides,
  };
}

describe("BedrockChatModel.generate", () => {
  it("maps the request to Converse and the response to a result", async () => {
    const converse = vi.fn().mockResolvedValue({
      output: { message: { content: [{ text: "he" }, { text: "llo" }] } },
      usage: { inputTokens: 3, outputTokens: 2 },
      stopReason: "end_turn",
    });
    const model = new BedrockChatModel(() => ({
      converse,
      converseStream: vi.fn(),
    }));

    const result = await model.generate(
      request({ system: "be brief", temperature: 0.2 })
    );

    expect(result).toEqual({
      text: "hello",
      usage: { inputTokens: 3, outputTokens: 2 },
      stopReason: "end_turn",
    });
    expect(converse.mock.calls[0]?.[0]).toEqual({
      modelId: "vendor.m1",
      system: [{ text: "be brief" }],
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      inferenceConfig: { maxTokens: 100, temperature: 0.2 },
    });
  });

  it("rejects maxOutputTokens above the model limit before calling", async () => {
    const converse = vi.fn();
    const model = new BedrockChatModel(() => ({
      converse,
      converseStream: vi.fn(),
    }));
    await expect(
      model.generate(request({ maxOutputTokens: 5000 }))
    ).rejects.toMatchObject({ code: "max_output_exceeded" });
    expect(converse).not.toHaveBeenCalled();
  });

  it("fails when the response has no usage", async () => {
    const model = new BedrockChatModel(() => ({
      converse: vi.fn().mockResolvedValue({ output: { message: {} } }),
      converseStream: vi.fn(),
    }));
    await expect(model.generate(request())).rejects.toMatchObject({
      code: "empty_response",
    });
  });

  it("wraps provider errors without leaking the raw message", async () => {
    const raw = new Error("secret request detail");
    raw.name = "ThrottlingException";
    const model = new BedrockChatModel(() => ({
      converse: vi.fn().mockRejectedValue(raw),
      converseStream: vi.fn(),
    }));
    const error = await model.generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).code).toBe("provider_error");
    expect((error as ModelError).message).not.toContain("secret");
  });

  it("selects the client by the model region", async () => {
    const clientFor = vi.fn((): ConverseClient => ({
      converse: vi.fn().mockResolvedValue({
        output: { message: { content: [{ text: "x" }] } },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      converseStream: vi.fn(),
    }));
    await new BedrockChatModel(clientFor).generate(
      request({ model: { ...priced, region: "us-east-1" } })
    );
    expect(clientFor).toHaveBeenCalledWith("us-east-1");
  });
});

async function collect(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function streamOf(events: unknown[]): ConverseClient {
  return {
    converse: vi.fn(),
    converseStream: vi.fn().mockResolvedValue({
      stream: (async function* () {
        for (const event of events) yield event;
      })(),
    }),
  };
}

describe("BedrockChatModel.stream", () => {
  it("yields text deltas then a done event with usage", async () => {
    const model = new BedrockChatModel(() =>
      streamOf([
        { contentBlockDelta: { delta: { text: "a" } } },
        { contentBlockDelta: { delta: { text: "b" } } },
        { messageStop: { stopReason: "max_tokens" } },
        { metadata: { usage: { inputTokens: 4, outputTokens: 2 } } },
      ])
    );
    expect(await collect(model.stream(request()))).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      {
        type: "done",
        usage: { inputTokens: 4, outputTokens: 2 },
        stopReason: "max_tokens",
      },
    ]);
  });

  it("fails when the stream ends without usage", async () => {
    const model = new BedrockChatModel(() =>
      streamOf([{ contentBlockDelta: { delta: { text: "a" } } }])
    );
    await expect(collect(model.stream(request()))).rejects.toMatchObject({
      code: "empty_response",
    });
  });

  it("wraps errors raised mid-stream", async () => {
    const model = new BedrockChatModel(() => ({
      converse: vi.fn(),
      converseStream: vi.fn().mockResolvedValue({
        stream: (async function* () {
          yield { contentBlockDelta: { delta: { text: "a" } } };
          throw new Error("boom");
        })(),
      }),
    }));
    await expect(collect(model.stream(request()))).rejects.toMatchObject({
      code: "provider_error",
    });
  });
});
