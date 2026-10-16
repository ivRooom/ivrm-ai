import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

describe("app", () => {
  it("responds to health checks", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    const config = loadConfig({});
    expect(config.PORT).toBe(3100);
    expect(config.AI_KILL_SWITCH).toBe(false);
  });

  it("rejects an invalid kill switch value", () => {
    expect(() => loadConfig({ AI_KILL_SWITCH: "yes" })).toThrow();
  });
});
