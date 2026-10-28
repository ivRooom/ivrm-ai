import { ModelCatalog } from "./catalog.js";
import type { ModelPricing, ModelSpec } from "./types.js";

// A model is callable only while it has a verified price (docs/design.md
// sections 4.2 and 5). Prices below were read from the AWS Price List API on
// 2026-10-20 (Tokyo, on-demand, standard tier, effective 2026-10-01) and are
// valid for 30 days: after that the cost gate refuses the model until the price
// is checked again (a changed price must never be under-counted).
const CHECKED_AT = "2026-10-20";
const VALID_UNTIL = "2026-11-19";

function priced(
  inputPerMTok: number,
  outputPerMTok: number,
  checkedAt = CHECKED_AT,
  validUntil = VALID_UNTIL
): ModelPricing {
  return { inputPerMTok, outputPerMTok, checkedAt, validUntil };
}

const specs: ModelSpec[] = [
  // Claude: invoked through an inference profile (Anthropic models have no
  // on-demand access by plain model id).
  //   Sonnet 5.5: not offered. Tokyo has only the global profile, so inference
  //     may run outside Japan; enabling it needs that decision (#13). Price
  //     (us-east-1 list, 2026-10-01): global 2.00 / 10.00, regional 2.20 / 11.00.
  //   Haiku 5.5: Japan profile (Tokyo / Osaka). AWS Price List
  //     (AmazonBedrockFoundationModels, ap-northeast-1, on-demand, regional
  //     "Standard", effective 2026-10-01), read 2026-10-28: input 0.11,
  //     output 0.55. Long-context requests are billed at 0.55 / 2.75; the
  //     cost gate uses the standard rate (see #13).
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    bedrockModelId: "global.anthropic.claude-sonnet-5-5",
    region: "ap-northeast-1",
    maxOutputTokens: 8192,
    supports: { tools: true, reasoning: false, vision: true },
    pricing: null,
  },
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    bedrockModelId: "jp.anthropic.claude-haiku-5-5",
    region: "ap-northeast-1",
    maxOutputTokens: 8192,
    supports: { tools: true, reasoning: false, vision: true },
    pricing: priced(0.11, 0.55, "2026-10-28", "2026-11-27"),
  },
  // gpt-oss-120b: $0.00018 / 1K input, $0.00073 / 1K output (Tokyo, on-demand).
  // Invoked once through Converse on 2026-10-20: access works.
  {
    id: "gpt-oss-120b",
    label: "gpt-oss 120B",
    bedrockModelId: "openai.gpt-oss-120b-1:0",
    region: "ap-northeast-1",
    maxOutputTokens: 4096,
    supports: { tools: true, reasoning: false, vision: false },
    pricing: priced(0.18, 0.73),
  },
  // DeepSeek V3.2: $0.00074 / 1K input, $0.00222 / 1K output (Tokyo, on-demand).
  // Invoked once through Converse on 2026-10-20: access works.
  {
    id: "deepseek-v3-2",
    label: "DeepSeek V3.2",
    bedrockModelId: "deepseek.v3.2",
    region: "ap-northeast-1",
    maxOutputTokens: 4096,
    supports: { tools: false, reasoning: false, vision: false },
    pricing: priced(0.74, 2.22),
  },
];

export function createDefaultCatalog(): ModelCatalog {
  return new ModelCatalog(specs);
}
