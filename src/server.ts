import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { createApp } from "./app.js";
import {
  ApiPolicyDecisionClient,
  StaticAllowPolicyDecisionClient,
} from "./auth/policy.js";
import { CachedPolicyDecisionClient } from "./auth/decision-cache.js";
import { ApiSessionVerifier } from "./auth/session.js";
import { PostgresChatStore } from "./chat/pg-store.js";
import { loadConfig } from "./config.js";
import { CostGate } from "./cost/gate.js";
import { DEFAULT_LIMITS } from "./cost/limits.js";
import { PostgresUsageStore } from "./cost/pg-store.js";
import { PostgresAuditLog } from "./db/audit.js";
import { BedrockChatModel, createConverseClient } from "./models/bedrock.js";
import { createDefaultCatalog } from "./models/default-catalog.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });

const policy =
  config.AI_POLICY_MODE === "static-allow"
    ? new StaticAllowPolicyDecisionClient()
    : // One round trip to api.ivrm.jp is reused for 30 seconds per user and
      // question, so a request does not turn into several.
      new CachedPolicyDecisionClient(
        new ApiPolicyDecisionClient(config.IVRM_API_BASE_URL)
      );

const catalog = createDefaultCatalog();

// One Bedrock client per region, created on first use.
const clients = new Map<string, ReturnType<typeof createConverseClient>>();
const model = new BedrockChatModel((region) => {
  let client = clients.get(region);
  if (!client) {
    client = createConverseClient(region);
    clients.set(region, client);
  }
  return client;
});

const gate = new CostGate({
  catalog,
  model,
  store: new PostgresUsageStore(pool),
  limits: DEFAULT_LIMITS,
  killSwitch: () => config.AI_KILL_SWITCH,
  onSettleError: (error) => console.error("cost settle failed", error),
});

const app = createApp({
  auth: {
    verifier: new ApiSessionVerifier(config.IVRM_API_BASE_URL),
    policy,
    allowedOrigin: config.AI_ALLOWED_ORIGIN,
  },
  chat: {
    store: new PostgresChatStore(pool),
    catalog,
    gate,
    policy,
    audit: new PostgresAuditLog(pool),
    maxOutputTokens: config.CHAT_MAX_OUTPUT_TOKENS,
  },
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`ivrm-ai listening on :${info.port}`);
});
