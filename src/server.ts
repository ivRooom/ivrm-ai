import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

serve({ fetch: createApp().fetch, port: config.PORT }, (info) => {
  console.log(`ivrm-ai listening on :${info.port}`);
});
