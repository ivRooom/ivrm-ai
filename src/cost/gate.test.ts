import { describe, expect, it, vi } from "vitest";
import { ModelCatalog } from "../models/catalog.js";
import type {
  ChatModel,
  GenerateResult,
  ModelSpec,
  StreamEvent,
} from "../models/types.js";
import { costMicroUsd, reserveMicroUsd } from "./estimate.js";
import { CostGate, GateError, type GatedRequest } from "./gate.js";
import { DEFAULT_LIMITS, type CostLimits } from "./limits.js";
import { InMemoryUsageStore } from "./memory-store.js";
import type { UsageStore } from "./store.js";

const now = new Date("2026-10-16T03:00:00Z");

const spec: ModelSpec = {
  id: "m1",
  label: "M1",
  bedrockModelId: "vendor.m1",
  region: "ap-northeast-1",
  maxOutputTokens: 1000,
  supports: { tools: false, reasoning: false, vision: false },
  // 1 micro-USD per input token, 2 per output token.
  pricing: {
    inputPerMTok: 1,
    outputPerMTok: 2,
    checkedAt: "2026-10-01",
    validUntil: "2026-12-31",
  },
};

const result: GenerateResult = {
  text: "ok",
  usage: { inputTokens: 10, outputTokens: 20 },
  stopReason: "end_turn",
};
// 10 * 1 + 20 * 2
const ACTUAL = 50;

function fakeModel(): ChatModel & {
  generate: ReturnType<typeof vi.fn>;
} {
  return {
    generate: vi.fn().mockResolvedValue(result),
    stream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text", text: "o" };
      yield { type: "done", usage: result.usage, stopReason: "end_turn" };
    }),
  };
}

function setup(
  overrides: {
    limits?: Partial<CostLimits>;
    killSwitch?: () => boolean;
    store?: UsageStore;
    model?: ChatModel;
    specs?: ModelSpec[];
  } = {}
) {
  const store = new InMemoryUsageStore();
  const model = overrides.model ?? fakeModel();
  const gate = new CostGate({
    catalog: new ModelCatalog(overrides.specs ?? [spec]),
    model,
    store: overrides.store ?? store,
    limits: { ...DEFAULT_LIMITS, ...overrides.limits },
    killSwitch: overrides.killSwitch ?? (() => false),
    now: () => now,
  });
  return { gate, store, model };
}

const req = (over: Partial<GatedRequest> = {}): GatedRequest => ({
  userId: "u1",
  modelId: "m1",
  messages: [{ role: "user", text: "hello" }],
  maxOutputTokens: 100,
  ...over,
});

async function drain(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

describe("estimate", () => {
  it("costs tokens in integer micro-USD", () => {
    expect(
      costMicroUsd(spec.pricing!, { inputTokens: 10, outputTokens: 20 })
    ).toBe(ACTUAL);
  });

  it("reserves using UTF-8 bytes as the input upper bound", () => {
    // "あ" is 3 bytes in UTF-8.
    const amount = reserveMicroUsd(spec.pricing!, {
      messages: [{ role: "user", text: "あ" }],
      maxOutputTokens: 10,
    });
    expect(amount).toBe(3 * 1 + 10 * 2);
  });

  it("bills the whole request at the long-context rate above its threshold", () => {
    const pricing = {
      ...spec.pricing!,
      longContext: { aboveInputTokens: 5, inputPerMTok: 10, outputPerMTok: 20 },
    };
    expect(costMicroUsd(pricing, { inputTokens: 5, outputTokens: 1 })).toBe(
      5 * 1 + 1 * 2
    );
    expect(costMicroUsd(pricing, { inputTokens: 6, outputTokens: 1 })).toBe(
      6 * 10 + 1 * 20
    );
    // Two "あ" are 6 bytes: the reservation assumes the long-context rate.
    expect(
      reserveMicroUsd(pricing, {
        messages: [{ role: "user", text: "ああ" }],
        maxOutputTokens: 1,
      })
    ).toBe(6 * 10 + 1 * 20);
  });
});

describe("CostGate.generate", () => {
  it("settles the actual cost after a successful call", async () => {
    const { gate, store, model } = setup();
    expect(await gate.generate(req())).toEqual(result);
    expect(model.generate).toHaveBeenCalledOnce();
    expect(store.usage("u1", now)).toEqual({
      userDaily: ACTUAL,
      globalMonthly: ACTUAL,
      inFlight: 0,
    });
  });

  it("refuses everything when the kill switch is on, without calling", async () => {
    const { gate, model } = setup({ killSwitch: () => true });
    await expect(gate.generate(req())).rejects.toMatchObject({
      code: "kill_switch",
    });
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("reads the kill switch on every call", async () => {
    let on = false;
    const { gate } = setup({ killSwitch: () => on });
    await gate.generate(req());
    on = true;
    await expect(gate.generate(req())).rejects.toBeInstanceOf(GateError);
  });

  it("refuses an unknown model", async () => {
    const { gate, model } = setup();
    await expect(gate.generate(req({ modelId: "x" }))).rejects.toMatchObject({
      code: "unknown_model",
    });
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("refuses an unpriced model", async () => {
    const { gate, model } = setup({ specs: [{ ...spec, pricing: null }] });
    await expect(gate.generate(req())).rejects.toMatchObject({
      code: "price_unverified",
    });
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("refuses once the price has expired", async () => {
    const expired: ModelSpec = {
      ...spec,
      pricing: { ...spec.pricing!, validUntil: "2026-10-15" },
    };
    const { gate, model } = setup({ specs: [expired] });
    await expect(gate.generate(req())).rejects.toMatchObject({
      code: "price_expired",
    });
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("refuses maxOutputTokens above the model limit before reserving", async () => {
    const { gate, store } = setup();
    await expect(
      gate.generate(req({ maxOutputTokens: 5000 }))
    ).rejects.toMatchObject({ code: "max_output_exceeded" });
    expect(store.usage("u1", now).inFlight).toBe(0);
    expect(store.usage("u1", now).userDaily).toBe(0);
  });

  it("refuses a request above the per-request cap", async () => {
    const { gate, model } = setup({ limits: { perRequestMicroUsd: 100 } });
    // reserve = 5 input bytes + 100 * 2 = 205 > 100
    await expect(gate.generate(req())).rejects.toMatchObject({
      code: "request_too_large",
    });
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("enforces the per-user daily limit", async () => {
    // Each call reserves 5 + 200 = 205 and settles at 50.
    const { gate, model } = setup({ limits: { userDailyMicroUsd: 400 } });
    await gate.generate(req()); // settled 50
    await gate.generate(req()); // settled 100
    await gate.generate(req()); // settled 150
    await gate.generate(req()); // settled 200
    // 200 + 205 > 400
    await expect(gate.generate(req())).rejects.toMatchObject({
      code: "limit_exceeded",
      reason: "user_daily",
    });
    expect(model.generate).toHaveBeenCalledTimes(4);
  });

  it("does not share the daily limit between users", async () => {
    const { gate } = setup({ limits: { userDailyMicroUsd: 210 } });
    await gate.generate(req({ userId: "a" }));
    await expect(gate.generate(req({ userId: "b" }))).resolves.toBeDefined();
  });

  it("enforces the global monthly limit across users", async () => {
    const { gate } = setup({ limits: { globalMonthlyMicroUsd: 400 } });
    await gate.generate(req({ userId: "a" })); // 50
    await gate.generate(req({ userId: "b" })); // 100
    await gate.generate(req({ userId: "c" })); // 150
    await gate.generate(req({ userId: "d" })); // 200
    await expect(gate.generate(req({ userId: "e" }))).rejects.toMatchObject({
      reason: "global_monthly",
    });
  });

  it("enforces the per-user rate limit", async () => {
    const { gate } = setup({ limits: { userRequestsPerMinute: 2 } });
    await gate.generate(req());
    await gate.generate(req());
    await expect(gate.generate(req())).rejects.toMatchObject({
      reason: "rate",
    });
  });

  it("enforces the concurrency limit and frees the slot afterwards", async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    const slow: ChatModel = {
      generate: vi.fn(async () => {
        await gateOpen;
        return result;
      }),
      stream: vi.fn(),
    };
    const { gate } = setup({ model: slow, limits: { maxConcurrent: 1 } });

    const first = gate.generate(req({ userId: "a" }));
    await expect(gate.generate(req({ userId: "b" }))).rejects.toMatchObject({
      reason: "concurrency",
    });
    release();
    await first;
    await expect(gate.generate(req({ userId: "b" }))).resolves.toBeDefined();
  });

  it("keeps the full reservation charged when the provider fails", async () => {
    const failing: ChatModel = {
      generate: vi.fn().mockRejectedValue(new Error("boom")),
      stream: vi.fn(),
    };
    const { gate, store } = setup({ model: failing });
    await expect(gate.generate(req())).rejects.toThrow("boom");
    // 5 input bytes + 100 * 2 output tokens.
    expect(store.usage("u1", now)).toEqual({
      userDaily: 205,
      globalMonthly: 205,
      inFlight: 0,
    });
  });

  it("refuses when the store is unavailable (fail closed)", async () => {
    const broken: UsageStore = {
      reserve: vi.fn().mockRejectedValue(new Error("db down")),
      settle: vi.fn(),
      release: vi.fn(),
    };
    const { gate, model } = setup({ store: broken });
    await expect(gate.generate(req())).rejects.toMatchObject({
      code: "store_unavailable",
    });
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("still returns the answer if settling fails, and reports it", async () => {
    const onSettleError = vi.fn();
    const store = new InMemoryUsageStore();
    const flaky: UsageStore = {
      reserve: (input) => store.reserve(input),
      settle: vi.fn().mockRejectedValue(new Error("db down")),
      release: (id) => store.release(id),
    };
    const gate = new CostGate({
      catalog: new ModelCatalog([spec]),
      model: fakeModel(),
      store: flaky,
      limits: DEFAULT_LIMITS,
      killSwitch: () => false,
      now: () => now,
      onSettleError,
    });
    await expect(gate.generate(req())).resolves.toEqual(result);
    expect(onSettleError).toHaveBeenCalledOnce();
  });
});

describe("CostGate.stream", () => {
  it("settles on the final usage", async () => {
    const { gate, store } = setup();
    const events = await drain(gate.stream(req()));
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(store.usage("u1", now)).toEqual({
      userDaily: ACTUAL,
      globalMonthly: ACTUAL,
      inFlight: 0,
    });
  });

  it("does not call the model when refused", async () => {
    const { gate, model } = setup({ killSwitch: () => true });
    await expect(drain(gate.stream(req()))).rejects.toMatchObject({
      code: "kill_switch",
    });
    expect(model.stream).not.toHaveBeenCalled();
  });

  it("keeps the full reservation when the consumer stops early", async () => {
    const { gate, store } = setup();
    for await (const _ of gate.stream(req())) {
      break;
    }
    expect(store.usage("u1", now)).toEqual({
      userDaily: 205,
      globalMonthly: 205,
      inFlight: 0,
    });
  });

  it("keeps the full reservation when the stream fails midway", async () => {
    const failing: ChatModel = {
      generate: vi.fn(),
      stream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text", text: "a" };
        throw new Error("boom");
      }),
    };
    const { gate, store } = setup({ model: failing });
    await expect(drain(gate.stream(req()))).rejects.toThrow("boom");
    expect(store.usage("u1", now).userDaily).toBe(205);
    expect(store.usage("u1", now).inFlight).toBe(0);
  });
});
