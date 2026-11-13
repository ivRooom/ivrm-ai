import type { GenerateRequest, ModelPricing, Usage } from "../models/types.js";

const encoder = new TextEncoder();

/** Cost in integer micro-USD. USD per 1M tokens equals micro-USD per token. */
export function costMicroUsd(pricing: ModelPricing, usage: Usage): number {
  const long = pricing.longContext;
  const rates =
    long && usage.inputTokens > long.aboveInputTokens ? long : pricing;
  return Math.ceil(
    usage.inputTokens * rates.inputPerMTok +
      usage.outputTokens * rates.outputPerMTok
  );
}

/**
 * Conservative upper bound reserved before the call. The input size uses the
 * UTF-8 byte length as the token count (a token is never shorter than a byte),
 * and the output uses the full maxOutputTokens. The byte count also picks the
 * long-context rate whenever the real token count could exceed its threshold.
 */
export function reserveMicroUsd(
  pricing: ModelPricing,
  request: Pick<GenerateRequest, "system" | "messages" | "maxOutputTokens">
): number {
  let bytes = request.system ? encoder.encode(request.system).length : 0;
  for (const message of request.messages) {
    bytes += encoder.encode(message.text).length;
  }
  return costMicroUsd(pricing, {
    inputTokens: bytes,
    outputTokens: request.maxOutputTokens,
  });
}
