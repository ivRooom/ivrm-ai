import { ModelError, type ModelPricing, type ModelSpec } from "./types.js";

export type CallableModel = ModelSpec & { pricing: ModelPricing };

/**
 * Allowlist of models. Clients send only a public id; anything not in the
 * catalog is rejected. A model is callable only while its price is verified.
 */
export class ModelCatalog {
  private readonly byId = new Map<string, ModelSpec>();

  constructor(specs: readonly ModelSpec[]) {
    for (const spec of specs) {
      if (this.byId.has(spec.id)) {
        throw new Error(`duplicate model id: ${spec.id}`);
      }
      this.byId.set(spec.id, spec);
    }
  }

  list(): ModelSpec[] {
    return [...this.byId.values()];
  }

  /** Models that are callable right now (priced and price not expired). */
  listCallable(now: Date): CallableModel[] {
    const callable: CallableModel[] = [];
    for (const spec of this.byId.values()) {
      if (isPriceValid(spec.pricing, now)) {
        callable.push({ ...spec, pricing: spec.pricing });
      }
    }
    return callable;
  }

  resolve(id: string, now: Date): CallableModel {
    const spec = this.byId.get(id);
    if (!spec) {
      throw new ModelError("unknown_model", `unknown model: ${id}`);
    }
    if (!spec.pricing) {
      throw new ModelError("price_unverified", `price not verified: ${id}`);
    }
    if (!isPriceValid(spec.pricing, now)) {
      throw new ModelError("price_expired", `price expired: ${id}`);
    }
    return { ...spec, pricing: spec.pricing };
  }
}

function isPriceValid(
  pricing: ModelPricing | null,
  now: Date
): pricing is ModelPricing {
  if (!pricing) return false;
  return now.toISOString().slice(0, 10) <= pricing.validUntil;
}
