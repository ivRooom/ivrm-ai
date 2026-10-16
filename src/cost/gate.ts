import type { ModelCatalog } from "../models/catalog.js";
import {
  ModelError,
  type ChatMessage,
  type ChatModel,
  type GenerateResult,
  type StreamEvent,
} from "../models/types.js";
import { costMicroUsd, reserveMicroUsd } from "./estimate.js";
import type { CostLimits } from "./limits.js";
import type { LimitReason, UsageStore } from "./store.js";

export type GateErrorCode =
  "kill_switch" | "request_too_large" | "limit_exceeded" | "store_unavailable";

export class GateError extends Error {
  readonly code: GateErrorCode;
  readonly reason: LimitReason | undefined;

  constructor(code: GateErrorCode, reason?: LimitReason) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "GateError";
    this.code = code;
    this.reason = reason;
  }
}

export type GatedRequest = {
  userId: string;
  modelId: string;
  system?: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type CostGateDeps = {
  catalog: ModelCatalog;
  model: ChatModel;
  store: UsageStore;
  limits: CostLimits;
  /** Read on every call so the switch takes effect without a restart. */
  killSwitch: () => boolean;
  now?: () => Date;
  /** Receives bookkeeping failures after the provider was already called. */
  onSettleError?: (error: unknown) => void;
};

/**
 * The only path to a model. Every call is authorized against the kill switch,
 * the model allowlist and price, per-request and per-user/global limits, and is
 * settled on the provider's reported usage. Anything it cannot decide is refused.
 */
export class CostGate {
  constructor(private readonly deps: CostGateDeps) {}

  async generate(request: GatedRequest): Promise<GenerateResult> {
    const prepared = await this.prepare(request);
    let settled = false;
    try {
      const result = await this.deps.model.generate(prepared.call);
      await this.finish(
        prepared.reservationId,
        costMicroUsd(prepared.pricing, result.usage)
      );
      settled = true;
      return result;
    } catch (error) {
      if (!settled) await this.abandon(prepared.reservationId, prepared.amount);
      throw error;
    }
  }

  async *stream(request: GatedRequest): AsyncGenerator<StreamEvent> {
    const prepared = await this.prepare(request);
    let settled = false;
    try {
      for await (const event of this.deps.model.stream(prepared.call)) {
        if (event.type === "done") {
          await this.finish(
            prepared.reservationId,
            costMicroUsd(prepared.pricing, event.usage)
          );
          settled = true;
        }
        yield event;
      }
    } finally {
      // Error, abort, or the consumer stopping early: usage is unknown, so the
      // full reservation stays charged.
      if (!settled) await this.abandon(prepared.reservationId, prepared.amount);
    }
  }

  private async prepare(request: GatedRequest) {
    const { catalog, store, limits } = this.deps;
    if (this.deps.killSwitch()) throw new GateError("kill_switch");

    const now = (this.deps.now ?? (() => new Date()))();
    const model = catalog.resolve(request.modelId, now);
    if (request.maxOutputTokens > model.maxOutputTokens) {
      throw new ModelError(
        "max_output_exceeded",
        `maxOutputTokens exceeds ${model.maxOutputTokens}`
      );
    }

    const amount = reserveMicroUsd(model.pricing, request);
    if (amount > limits.perRequestMicroUsd) {
      throw new GateError("request_too_large");
    }

    let reserved;
    try {
      reserved = await store.reserve({
        userId: request.userId,
        amountMicroUsd: amount,
        limits,
        now,
      });
    } catch {
      throw new GateError("store_unavailable");
    }
    if (!reserved.ok) throw new GateError("limit_exceeded", reserved.reason);

    return {
      reservationId: reserved.reservationId,
      amount,
      pricing: model.pricing,
      call: {
        model,
        messages: request.messages,
        maxOutputTokens: request.maxOutputTokens,
        ...(request.system !== undefined ? { system: request.system } : {}),
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    };
  }

  /** Settle on actual usage. A bookkeeping failure must not hide the answer. */
  private async finish(reservationId: string, actual: number) {
    try {
      await this.deps.store.settle(reservationId, actual);
    } catch (error) {
      this.deps.onSettleError?.(error);
    }
  }

  /** The call failed or ended without usage: keep the reservation as the charge. */
  private async abandon(reservationId: string, amount: number) {
    await this.finish(reservationId, amount);
  }
}
