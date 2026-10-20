import { ModelCatalog } from "./catalog.js";
import type { ModelPricing, ModelSpec } from "./types.js";

// A model is callable only while it has a verified price (docs/design.md
// sections 4.2 and 5). Prices below were read from the AWS Price List API on
// 2026-10-20 (Tokyo, on-demand, standard tier, effective 2026-10-01) and are
// valid for 30 days: after that the cost gate refuses the model until the price
// is checked again (a changed price must never be under-counted).
const CHECKED_AT = "2026-10-20";
const VALID_UNTIL = "2026-11-19";

function priced(inputPerMTok: number, outputPerMTok: number): ModelPricing {
  return {
    inputPerMTok,
    outputPerMTok,
    checkedAt: CHECKED_AT,
    validUntil: VALID_UNTIL,
  };
}

const specs: ModelSpec[] = [
  // Claude: invoked through an inference profile (the plain model id cannot be
  // invoked). Not offered yet: the AWS account has no access to the Anthropic
  // models ("not available for this account", checked 2026-10-20), which needs
  // the Bedrock use-case form / subscription by an account owner (#13).
  // Verified prices, to be enabled together with the access:
  //   Sonnet 5.5, global profile (standard, Global): input 2.00, output 10.00;
  //     the regional "Standard" rate is 2.20 / 11.00, use that to stay on the
  //     safe side. Only a global profile exists for Tokyo (data may leave Japan).
  //   Haiku 5.5, Japan profile (Standard, Tokyo): input 0.11, output 0.55.
  //   Long-context requests cost more (Haiku: input 0.50, output 2.50 global);
  //   keep inputs far below the long-context threshold.
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
    pricing: null,
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
