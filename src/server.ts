import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import {
  ApiPolicyDecisionClient,
  StaticAllowPolicyDecisionClient,
} from "./auth/policy.js";
import { ApiSessionVerifier } from "./auth/session.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

const app = createApp({
  auth: {
    verifier: new ApiSessionVerifier(config.IVRM_API_BASE_URL),
    policy:
      config.AI_POLICY_MODE === "static-allow"
        ? new StaticAllowPolicyDecisionClient()
        : new ApiPolicyDecisionClient(config.IVRM_API_BASE_URL),
    allowedOrigin: config.AI_ALLOWED_ORIGIN,
  },
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`ivrm-ai listening on :${info.port}`);
});
