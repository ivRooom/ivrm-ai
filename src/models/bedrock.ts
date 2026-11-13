import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ConverseStreamCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  ModelError,
  type ChatModel,
  type GenerateRequest,
  type GenerateResult,
  type StopReason,
  type StreamEvent,
  type Usage,
} from "./types.js";

/** The slice of the Bedrock client this adapter needs (injectable for tests). */
export interface ConverseClient {
  converse(
    input: ConverseCommandInput,
    signal?: AbortSignal
  ): Promise<ConverseCommandOutput>;
  converseStream(
    input: ConverseCommandInput,
    signal?: AbortSignal
  ): Promise<ConverseStreamCommandOutput>;
}

export function createConverseClient(region: string): ConverseClient {
  const client = new BedrockRuntimeClient({ region });
  return {
    converse: (input, signal) =>
      client.send(new ConverseCommand(input), sendOptions(signal)),
    converseStream: (input, signal) =>
      client.send(new ConverseStreamCommand(input), sendOptions(signal)),
  };
}

function sendOptions(signal: AbortSignal | undefined) {
  return signal ? { abortSignal: signal } : {};
}

export class BedrockChatModel implements ChatModel {
  constructor(private readonly clientFor: (region: string) => ConverseClient) {}

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const input = toConverseInput(request);
    let output: ConverseCommandOutput;
    try {
      output = await this.clientFor(request.model.region).converse(
        input,
        request.signal
      );
    } catch (error) {
      throw providerError(error);
    }

    // The cost gate settles on provider usage; a response without it is an error.
    if (!output.usage) {
      throw new ModelError("empty_response", "response has no usage");
    }
    const text = (output.output?.message?.content ?? [])
      .map((block) => block.text ?? "")
      .join("");
    return {
      text,
      usage: toUsage(output.usage),
      stopReason: toStopReason(output.stopReason),
    };
  }

  async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
    const input = toConverseInput(request);
    let response: ConverseStreamCommandOutput;
    try {
      response = await this.clientFor(request.model.region).converseStream(
        input,
        request.signal
      );
    } catch (error) {
      throw providerError(error);
    }

    let usage: Usage | undefined;
    let stopReason: StopReason = "other";
    try {
      for await (const event of response.stream ?? []) {
        const text = event.contentBlockDelta?.delta?.text;
        if (text) yield { type: "text", text };
        if (event.messageStop) {
          stopReason = toStopReason(event.messageStop.stopReason);
        }
        if (event.metadata?.usage) usage = toUsage(event.metadata.usage);
      }
    } catch (error) {
      throw providerError(error);
    }

    if (!usage) {
      throw new ModelError("empty_response", "stream ended without usage");
    }
    yield { type: "done", usage, stopReason };
  }
}

function toConverseInput(request: GenerateRequest): ConverseCommandInput {
  if (request.maxOutputTokens > request.model.maxOutputTokens) {
    throw new ModelError(
      "max_output_exceeded",
      `maxOutputTokens exceeds ${request.model.maxOutputTokens}`
    );
  }
  return {
    modelId: request.model.bedrockModelId,
    ...(request.system ? { system: [{ text: request.system }] } : {}),
    messages: request.messages.map((message) => ({
      role: message.role,
      content: [{ text: message.text }],
    })),
    inferenceConfig: {
      maxTokens: request.maxOutputTokens,
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    },
    ...(request.model.requestFields
      ? {
          additionalModelRequestFields: request.model
            .requestFields as ConverseCommandInput["additionalModelRequestFields"],
        }
      : {}),
  };
}

function toUsage(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}): Usage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

function toStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "stop_sequence":
    case "content_filtered":
      return reason;
    default:
      return "other";
  }
}

function providerError(error: unknown): ModelError {
  // The raw SDK error can carry request details; expose only a safe message.
  const name = error instanceof Error ? error.name : "UnknownError";
  return new ModelError("provider_error", `bedrock call failed: ${name}`, {
    cause: error,
  });
}
