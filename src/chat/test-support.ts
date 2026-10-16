import { vi } from "vitest";
import type { PolicyDecisionClient } from "../auth/policy.js";
import { CostGate } from "../cost/gate.js";
import { DEFAULT_LIMITS, type CostLimits } from "../cost/limits.js";
import { InMemoryUsageStore } from "../cost/memory-store.js";
import type { AuditEntry, AuditLog } from "../db/audit.js";
import { ModelCatalog } from "../models/catalog.js";
import type {
  ChatModel,
  GenerateRequest,
  ModelSpec,
  StreamEvent,
} from "../models/types.js";
import { InMemoryChatStore } from "./memory-store.js";
import type { ChatDeps } from "./routes.js";

export const NOW = new Date("2026-10-16T03:00:00Z");

export const SPEC: ModelSpec = {
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

export class RecordingAudit implements AuditLog {
  readonly entries: AuditEntry[] = [];
  async record(entry: AuditEntry) {
    this.entries.push(entry);
  }
}

export function scriptedModel(
  chunks: string[] = ["he", "llo"],
  usage = { inputTokens: 10, outputTokens: 20 }
): ChatModel & { requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  return {
    requests,
    generate: vi.fn(),
    stream: async function* (request): AsyncGenerator<StreamEvent> {
      requests.push(request);
      for (const text of chunks) yield { type: "text", text };
      yield { type: "done", usage, stopReason: "end_turn" };
    },
  };
}

export function makeChatDeps(
  opts: {
    model?: ChatModel;
    policy?: PolicyDecisionClient;
    specs?: ModelSpec[];
    limits?: Partial<CostLimits>;
    killSwitch?: boolean;
  } = {}
) {
  const store = new InMemoryChatStore();
  const usage = new InMemoryUsageStore();
  const audit = new RecordingAudit();
  const model = opts.model ?? scriptedModel();
  const catalog = new ModelCatalog(opts.specs ?? [SPEC]);
  const policy: PolicyDecisionClient = opts.policy ?? {
    authorize: async () => ({ allowed: true }),
  };
  const gate = new CostGate({
    catalog,
    model,
    store: usage,
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
    killSwitch: () => opts.killSwitch ?? false,
    now: () => NOW,
  });
  const deps: ChatDeps = {
    store,
    catalog,
    gate,
    policy,
    audit,
    maxOutputTokens: 100,
    now: () => NOW,
  };
  return { deps, store, usage, audit, model };
}
