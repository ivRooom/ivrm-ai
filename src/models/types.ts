export type ModelPricing = {
  /** USD per 1,000,000 input tokens. */
  inputPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMTok: number;
  /** Date (YYYY-MM-DD) the price was checked against the provider. */
  checkedAt: string;
  /** Last date (YYYY-MM-DD, inclusive) the price may be relied on. */
  validUntil: string;
  /**
   * Higher rates the provider bills for the whole request once its input
   * exceeds `aboveInputTokens` (long-context pricing).
   */
  longContext?: {
    aboveInputTokens: number;
    inputPerMTok: number;
    outputPerMTok: number;
  };
};

export type ModelSpec = {
  /** Stable public id used by clients and policies (`ivrm:ai:model/<id>`). */
  id: string;
  label: string;
  /** Bedrock model id or inference profile id passed to Converse. */
  bedrockModelId: string;
  region: string;
  maxOutputTokens: number;
  supports: { tools: boolean; reasoning: boolean; vision: boolean };
  /** Null until verified. A model without a valid price is never callable. */
  pricing: ModelPricing | null;
  /** Model-specific fields passed as Converse `additionalModelRequestFields`. */
  requestFields?: Record<string, unknown>;
};

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

export type GenerateRequest = {
  model: ModelSpec;
  system?: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type Usage = { inputTokens: number; outputTokens: number };

export type StopReason =
  "end_turn" | "max_tokens" | "stop_sequence" | "content_filtered" | "other";

export type GenerateResult = {
  text: string;
  usage: Usage;
  stopReason: StopReason;
};

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; usage: Usage; stopReason: StopReason };

export interface ChatModel {
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>;
}

export type ModelErrorCode =
  | "unknown_model"
  | "price_unverified"
  | "price_expired"
  | "max_output_exceeded"
  | "provider_error"
  | "empty_response";

export class ModelError extends Error {
  readonly code: ModelErrorCode;

  constructor(code: ModelErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelError";
    this.code = code;
  }
}
