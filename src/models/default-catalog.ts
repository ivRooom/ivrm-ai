import { ModelCatalog } from "./catalog.js";
import type { ModelSpec } from "./types.js";

// Prices are intentionally null: they must be verified against the AWS price
// list before a model is enabled (docs/design.md section 4.2 and 5). Until
// then the cost gate cannot reserve a budget, so none of these can be called.
const specs: ModelSpec[] = [
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    bedrockModelId: "anthropic.claude-sonnet-5-5",
    region: "ap-northeast-1",
    maxOutputTokens: 8192,
    supports: { tools: true, reasoning: false, vision: true },
    pricing: null,
  },
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    bedrockModelId: "anthropic.claude-haiku-5-5",
    region: "ap-northeast-1",
    maxOutputTokens: 8192,
    supports: { tools: true, reasoning: false, vision: true },
    pricing: null,
  },
  {
    id: "gpt-oss-120b",
    label: "gpt-oss 120B",
    bedrockModelId: "openai.gpt-oss-120b-1:0",
    region: "ap-northeast-1",
    maxOutputTokens: 4096,
    supports: { tools: true, reasoning: false, vision: false },
    pricing: null,
  },
  {
    id: "deepseek-v3-2",
    label: "DeepSeek V3.2",
    bedrockModelId: "deepseek.v3.2",
    region: "ap-northeast-1",
    maxOutputTokens: 4096,
    supports: { tools: false, reasoning: false, vision: false },
    pricing: null,
  },
];

export function createDefaultCatalog(): ModelCatalog {
  return new ModelCatalog(specs);
}
