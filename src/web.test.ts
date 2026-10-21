import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, webHandler, type WebAssets } from "./web.js";

const assets: WebAssets = {
  indexHtml: "<!doctype html><title>t</title>",
  appJs: "console.log(1)",
  stylesCss: "body{}",
};

function app() {
  const a = new Hono();
  a.get("*", webHandler(assets));
  return a;
}

describe("webHandler", () => {
  it.each(["/", "/c/abc", "/anything"])(
    "serves the page for %s with a strict CSP",
    async (path) => {
      const res = await app().request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-security-policy")).toBe(
        CONTENT_SECURITY_POLICY
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe(assets.indexHtml);
    }
  );

  it("serves the bundle and the stylesheet", async () => {
    const js = await app().request("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toBe(assets.appJs);
    const css = await app().request("/assets/styles.css");
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("does not turn unknown assets or API paths into the page", async () => {
    // A path never reaches the filesystem; this one is normalized to /server.js.
    expect(await (await app().request("/assets/../server.js")).text()).toBe(
      assets.indexHtml
    );
    expect((await app().request("/assets/x.js")).status).toBe(404);
    const api = await app().request("/api/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not_found" });
  });

  it("allows no inline script, foreign images or framing", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });
});
