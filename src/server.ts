import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { KillSwitch, PostgresKillSwitchStore } from "./ops/kill-switch.js";
import { loadWebAssets } from "./web.js";

const config = loadConfig();
// The database (max_connections 30) is shared with other services; this role may
// open 8, so the app keeps 5 and leaves room for the CLIs and a deploy overlap.
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

const policy =
  config.AI_POLICY_MODE === "static-allow"
    ? new StaticAllowPolicyDecisionClient()
    : // One round trip to api.ivrm.jp is reused for 30 seconds per user and
      // question, so a request does not turn into several.
      new CachedPolicyDecisionClient(
        new ApiPolicyDecisionClient(config.IVRM_API_BASE_URL)
      );

const catalog = createDefaultCatalog();

// AI_KILL_SWITCH=true (fixed at deploy) always wins. Otherwise the stored switch
// is re-read every few seconds, so it can be turned on or off without a restart
// (src/ops/kill-switch-cli.ts). Unreadable for 30 seconds counts as on.
const killSwitch = new KillSwitch({
  store: new PostgresKillSwitchStore(pool),
  forcedOn: config.AI_KILL_SWITCH,
  onError: (error) => console.error("kill switch read failed", error),
});
await killSwitch.start();

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
  killSwitch: () => killSwitch.isOn(),
  onSettleError: (error) => console.error("cost settle failed", error),
});

// Built by `pnpm build` (scripts/build-web.mjs) into dist/public. Required in
// production; in development (`pnpm dev`, run from src/) only the API is served.
const web = await loadWebAssets(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "public"),
  new URL("/auth/discord/login", config.IVRM_API_BASE_URL).toString()
).catch((error: unknown) => {
  if (config.NODE_ENV === "production") throw error;
  console.warn("chat UI not built; serving the API only");
  return undefined;
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
  ...(web ? { web } : {}),
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`ivrm-ai listening on :${info.port}`);
});
